(function attachSoundCoverageModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SoundCoverageModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createModel() {
  "use strict";

  const EPSILON = 1e-9;
  const MAX_GRID_CELLS = 30000;
  const MAX_AUTO_SAMPLES = 1600;

  const MODE_CRITERIA = Object.freeze({
    paging: {
      label: "In-plant paging",
      shortLabel: "PAGING",
      weighting: "A",
      receiverHeight: 1.5,
      sourceHeight: 3,
      ambientLevel: 63,
      requiredMargin: 10,
      minimumLevel: 80,
      maximumLevel: 110,
      enforceMaximum: true,
      fixedLoss: 0,
      note: "Minimum 80 dBA and at least 10 dB above ambient; not greater than 110 dBA.",
      sourceRef: "CE-040449-001, sections 3.1-3.2 (document pages 8-9)",
    },
    publicAddress: {
      label: "Public address",
      shortLabel: "PA",
      weighting: "A",
      receiverHeight: 1.5,
      sourceHeight: 3,
      ambientLevel: 48,
      requiredMargin: 10,
      minimumLevel: 0,
      maximumLevel: 110,
      enforceMaximum: true,
      fixedLoss: 0,
      note: "At least 10 dB above ambient; personnel locations should not exceed 110 dBA.",
      sourceRef: "CE-040451-001, sections 3.1-3.2 (document pages 7-8)",
    },
    siren: {
      label: "Emergency siren",
      shortLabel: "ESS",
      weighting: "C",
      receiverHeight: 1.5,
      sourceHeight: 15,
      ambientLevel: 80,
      requiredMargin: 15,
      minimumLevel: 0,
      maximumLevel: 105,
      enforceMaximum: false,
      fixedLoss: 0,
      note: "At least 15 dB above ambient. The source study states a 105 dBA personnel limit while mapping in dBC, so the maximum is not enforced until weightings are reconciled.",
      sourceRef: "CE-040450-001, sections 3.1-3.2 (document pages 7-8)",
    },
  });

  const DEVICE_PRESETS = Object.freeze({
    horn25: {
      key: "horn25",
      name: "25 W project horn",
      model: "DSP-15EExmNT profile",
      referenceSpl: 105,
      referenceDistance: 1,
      referencePower: 1,
      tapPower: 25,
      ratedPower: 25,
      beamWidth: 120,
      rearAttenuation: 20,
      nearFieldDistance: 1,
      sourceHeight: 3,
      weighting: "A",
      confidence: "verify",
      provenance: "The repository studies identify the 25 W DNH model, but the embedded source does not expose a machine-readable sensitivity value. The 105 dB reference is an editable screening placeholder.",
    },
    horn15: {
      key: "horn15",
      name: "15 W project horn",
      model: "Drawing schedule profile",
      referenceSpl: 103,
      referenceDistance: 1,
      referencePower: 1,
      tapPower: 7.5,
      ratedPower: 15,
      beamWidth: 120,
      rearAttenuation: 18,
      nearFieldDistance: 1,
      sourceHeight: 2.5,
      weighting: "A",
      confidence: "verify",
      provenance: "Maintenance Building_PAGA.pdf identifies 15 W horns, including a 7.5 W tap. Sensitivity is an editable screening placeholder.",
    },
    ceiling6: {
      key: "ceiling6",
      name: "6 W ceiling speaker",
      model: "Project drawing profile",
      referenceSpl: 92,
      referenceDistance: 1,
      referencePower: 1,
      tapPower: 6,
      ratedPower: 6,
      beamWidth: 180,
      rearAttenuation: 12,
      nearFieldDistance: 1,
      sourceHeight: 3,
      weighting: "A",
      confidence: "verify",
      provenance: "The project drawings identify 6 W ceiling loudspeakers. Sensitivity and polar behavior remain editable placeholders.",
    },
    siren3200: {
      key: "siren3200",
      name: "3.2 kW siren array",
      model: "MOD8032B study profile",
      referenceSpl: 118,
      referenceDistance: 30,
      referencePower: 3200,
      tapPower: 3200,
      ratedPower: 3200,
      beamWidth: 360,
      rearAttenuation: 0,
      nearFieldDistance: 30,
      sourceHeight: 15,
      weighting: "C",
      confidence: "sourced",
      provenance: "CE-040450-001 reports 118 dBC at 30 m and 1000 Hz for the Federal Signal MOD8032B, with a 3200 W system rating.",
    },
    custom: {
      key: "custom",
      name: "Custom source",
      model: "User defined",
      referenceSpl: 100,
      referenceDistance: 1,
      referencePower: 1,
      tapPower: 10,
      ratedPower: 10,
      beamWidth: 360,
      rearAttenuation: 0,
      nearFieldDistance: 1,
      sourceHeight: 3,
      weighting: "A",
      confidence: "user",
      provenance: "User-entered acoustic data.",
    },
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function makeId(prefix = "item") {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function degreesToRadians(value) {
    return (value * Math.PI) / 180;
  }

  function normalizeAngle(value) {
    const angle = finiteNumber(value, 0) % 360;
    return angle < 0 ? angle + 360 : angle;
  }

  function smallestAngleDifference(a, b) {
    const delta = Math.abs(normalizeAngle(a) - normalizeAngle(b)) % 360;
    return delta > 180 ? 360 - delta : delta;
  }

  function energeticSum(levels) {
    let energy = 0;
    for (const level of levels) {
      if (Number.isFinite(level)) energy += 10 ** (level / 10);
    }
    return energy > 0 ? 10 * Math.log10(energy) : -Infinity;
  }

  function sourceBearing(source, x, y) {
    const angle = (Math.atan2(y - source.y, x - source.x) * 180) / Math.PI;
    return normalizeAngle(angle);
  }

  function beamPlaneLoss(difference, beamWidth, maximumLoss) {
    const width = clamp(finiteNumber(beamWidth, 360), 1, 360);
    const lossLimit = Math.max(0, finiteNumber(maximumLoss, 0));
    if (width >= 359.9 || lossLimit <= EPSILON) return 0;
    const angle = clamp(Math.abs(finiteNumber(difference, 0)), 0, 180);
    const edge = Math.max(0.5, width / 2);
    if (angle <= edge) return Math.min(lossLimit, 6 * (angle / edge) ** 2);
    const tailSpan = Math.max(0.5, 180 - edge);
    return Math.min(lossLimit, 6 + (lossLimit - 6) * ((angle - edge) / tailSpan));
  }

  function directivityLoss(source, x, y, receiverHeight = finiteNumber(source.z, 0)) {
    const rear = Math.max(0, finiteNumber(source.rearAttenuation, 0));
    if (rear <= EPSILON) return 0;
    const horizontalDifference = smallestAngleDifference(source.azimuth, sourceBearing(source, x, y));
    const horizontalLoss = beamPlaneLoss(horizontalDifference, source.beamWidth, rear);
    const dx = x - finiteNumber(source.x, 0);
    const dy = y - finiteNumber(source.y, 0);
    const horizontalDistance = Math.hypot(dx, dy);
    const elevationAngle = (Math.atan2(receiverHeight - finiteNumber(source.z, 0), horizontalDistance) * 180) / Math.PI;
    const verticalDifference = Math.abs(elevationAngle - clamp(finiteNumber(source.elevation, 0), -90, 90));
    const verticalLoss = beamPlaneLoss(verticalDifference, source.verticalBeamWidth, rear);
    return Math.min(rear, horizontalLoss + verticalLoss);
  }
  function segmentRectangleInterval(x0, y0, x1, y1, rectangle) {
    const left = finiteNumber(rectangle.x, 0);
    const top = finiteNumber(rectangle.y, 0);
    const right = left + Math.max(0, finiteNumber(rectangle.width, 0));
    const bottom = top + Math.max(0, finiteNumber(rectangle.depth, 0));
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;

    const checks = [
      [-dx, x0 - left],
      [dx, right - x0],
      [-dy, y0 - top],
      [dy, bottom - y0],
    ];

    for (const [p, q] of checks) {
      if (Math.abs(p) < EPSILON) {
        if (q < 0) return null;
        continue;
      }
      const ratio = q / p;
      if (p < 0) {
        if (ratio > t1) return null;
        if (ratio > t0) t0 = ratio;
      } else {
        if (ratio < t0) return null;
        if (ratio < t1) t1 = ratio;
      }
    }
    return [t0, t1];
  }

  function obstacleLoss(project, source, x, y) {
    const obstacles = Array.isArray(project.obstacles) ? project.obstacles : [];
    const receiverHeight = finiteNumber(project.receiverHeight, 1.5);
    let total = 0;
    for (const obstacle of obstacles) {
      if (obstacle.enabled === false) continue;
      const interval = segmentRectangleInterval(source.x, source.y, x, y, obstacle);
      if (!interval) continue;
      const midpoint = (interval[0] + interval[1]) / 2;
      if (midpoint <= EPSILON || midpoint >= 1 - EPSILON) continue;
      const rayHeight = source.z + (receiverHeight - source.z) * midpoint;
      if (rayHeight <= finiteNumber(obstacle.height, 6)) {
        total += Math.max(0, finiteNumber(obstacle.loss, 10));
      }
    }
    return total;
  }

  function sourceLevelAtPoint(project, source, x, y) {
    const power = Math.max(EPSILON, finiteNumber(source.tapPower, 1));
    const referencePower = Math.max(EPSILON, finiteNumber(source.referencePower, 1));
    const referenceDistance = Math.max(EPSILON, finiteNumber(source.referenceDistance, 1));
    const nearFieldDistance = Math.max(EPSILON, finiteNumber(source.nearFieldDistance, 1));
    const receiverHeight = finiteNumber(project.receiverHeight, 1.5);
    const dx = x - finiteNumber(source.x, 0);
    const dy = y - finiteNumber(source.y, 0);
    const dz = receiverHeight - finiteNumber(source.z, 3);
    const geometricDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distance = Math.max(nearFieldDistance, geometricDistance);
    const powerAdjustment = 10 * Math.log10(power / referencePower);
    const distanceAdjustment = 20 * Math.log10(distance / referenceDistance);
    const directionAdjustment = directivityLoss(source, x, y, receiverHeight);
    const barriers = obstacleLoss(project, source, x, y);
    const atmospheric = Math.max(0, finiteNumber(project.airLossPer100m, 0)) * (distance / 100);
    const fixedLoss = Math.max(0, finiteNumber(project.fixedLoss, 0));
    const sourceLoss = Math.max(0, finiteNumber(source.additionalLoss, 0));
    return (
      finiteNumber(source.referenceSpl, 0) +
      powerAdjustment -
      distanceAdjustment -
      directionAdjustment -
      barriers -
      atmospheric -
      fixedLoss -
      sourceLoss
    );
  }

  function noiseAtPoint(project, x, y) {
    let ambient = finiteNumber(project.ambientLevel, 0);
    const zones = Array.isArray(project.noiseZones) ? project.noiseZones : [];
    for (const zone of zones) {
      if (zone.enabled === false) continue;
      const inside =
        x >= finiteNumber(zone.x, 0) &&
        y >= finiteNumber(zone.y, 0) &&
        x <= finiteNumber(zone.x, 0) + Math.max(0, finiteNumber(zone.width, 0)) &&
        y <= finiteNumber(zone.y, 0) + Math.max(0, finiteNumber(zone.depth, 0));
      if (inside) ambient = Math.max(ambient, finiteNumber(zone.level, ambient));
    }
    return ambient;
  }

  function targetForNoise(project, ambient) {
    return Math.max(
      finiteNumber(project.minimumLevel, 0),
      ambient + Math.max(0, finiteNumber(project.requiredMargin, 0)),
    );
  }

  function calculatePoint(project, x, y) {
    const sources = Array.isArray(project.sources) ? project.sources.filter((source) => source.enabled !== false) : [];
    const levels = sources.map((source) => sourceLevelAtPoint(project, source, x, y));
    const level = energeticSum(levels);
    const ambient = noiseAtPoint(project, x, y);
    const target = targetForNoise(project, ambient);
    const margin = Number.isFinite(level) ? level - ambient : -Infinity;
    const enforceMaximum = Boolean(project.enforceMaximum);
    const maximum = finiteNumber(project.maximumLevel, Infinity);
    let status = "empty";
    if (Number.isFinite(level)) {
      if (level < target) status = "below";
      else if (enforceMaximum && level > maximum) status = "over";
      else status = "compliant";
    }
    return { x, y, level, ambient, target, margin, status };
  }

  function calculateGrid(project) {
    const width = Math.max(1, finiteNumber(project.width, 80));
    const depth = Math.max(1, finiteNumber(project.depth, 50));
    const requestedSpacing = Math.max(0.25, finiteNumber(project.gridSpacing, 2));
    const minimumSpacing = Math.sqrt((width * depth) / MAX_GRID_CELLS);
    const spacing = Math.max(requestedSpacing, minimumSpacing);
    const columns = Math.max(1, Math.ceil(width / spacing));
    const rows = Math.max(1, Math.ceil(depth / spacing));
    const cellWidth = width / columns;
    const cellDepth = depth / rows;
    const points = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        points.push(calculatePoint(project, (column + 0.5) * cellWidth, (row + 0.5) * cellDepth));
      }
    }
    return { width, depth, spacing, requestedSpacing, columns, rows, cellWidth, cellDepth, points };
  }

  function createPlacementGrid(rectangle, columns, rows) {
    const x = finiteNumber(rectangle && rectangle.x, 0);
    const y = finiteNumber(rectangle && rectangle.y, 0);
    const width = Math.max(0, finiteNumber(rectangle && rectangle.width, 0));
    const depth = Math.max(0, finiteNumber(rectangle && rectangle.depth, 0));
    const safeColumns = Math.max(1, Math.floor(finiteNumber(columns, 1)));
    const safeRows = Math.max(1, Math.floor(finiteNumber(rows, 1)));
    const spacingX = width / safeColumns;
    const spacingY = depth / safeRows;
    const points = [];
    for (let row = 0; row < safeRows; row += 1) {
      for (let column = 0; column < safeColumns; column += 1) {
        points.push({
          x: x + (column + 0.5) * spacingX,
          y: y + (row + 0.5) * spacingY,
          row,
          column,
        });
      }
    }
    return {
      x,
      y,
      width,
      depth,
      columns: safeColumns,
      rows: safeRows,
      count: points.length,
      spacingX,
      spacingY,
      points,
    };
  }

  function createPlacementSamples(rectangle, requestedSpacing) {
    const x = finiteNumber(rectangle && rectangle.x, 0);
    const y = finiteNumber(rectangle && rectangle.y, 0);
    const width = Math.max(0.5, finiteNumber(rectangle && rectangle.width, 0.5));
    const depth = Math.max(0.5, finiteNumber(rectangle && rectangle.depth, 0.5));
    const sampleFloor = Math.sqrt((width * depth) / MAX_AUTO_SAMPLES);
    const spacing = Math.max(0.25, finiteNumber(requestedSpacing, 2), sampleFloor);
    const columns = Math.max(1, Math.ceil(width / spacing));
    const rows = Math.max(1, Math.ceil(depth / spacing));
    const points = [];
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        points.push({
          x: x + (column / columns) * width,
          y: y + (row / rows) * depth,
        });
      }
    }
    return { spacing, columns, rows, points };
  }

  function createPlacementSources(deviceKey, placementGrid, options = {}) {
    const baseAzimuth = normalizeAngle(finiteNumber(options.baseAzimuth, 0));
    const alternateAzimuth = options.alternateAzimuth !== false;
    return placementGrid.points.map((point, index) => {
      const alternate = alternateAzimuth && (point.row + point.column) % 2 === 1;
      return instantiateDevice(deviceKey, {
        name: `AUTO-${String(index + 1).padStart(3, "0")}`,
        x: point.x,
        y: point.y,
        azimuth: normalizeAngle(baseAzimuth + (alternate ? 180 : 0)),
        loop: `AUTO-${Math.max(1, Math.ceil((index + 1) / 8))}`,
      });
    });
  }

  function assessPlacementGrid(project, deviceKey, rectangle, placementGrid, options = {}, sampleSet = null) {
    const designMargin = clamp(finiteNumber(options.designMargin, 3), 0, 20);
    const includeExisting = options.includeExisting !== false;
    const existingSources = includeExisting && Array.isArray(project.sources) ? project.sources : [];
    const proposedSources = createPlacementSources(deviceKey, placementGrid, options);
    const assessmentProject = { ...project, sources: [...existingSources, ...proposedSources] };
    const samples = sampleSet || createPlacementSamples(rectangle, project.gridSpacing);
    const assessmentPoints = [...samples.points, ...placementGrid.points];
    let compliant = 0;
    let below = 0;
    let over = 0;
    let minimumReserve = Infinity;
    let maximumLevel = -Infinity;
    let worstPoint = null;
    for (const point of assessmentPoints) {
      const result = calculatePoint(assessmentProject, point.x, point.y);
      const reserve = Number.isFinite(result.level) ? result.level - result.target : -Infinity;
      const belowDesign = reserve < designMargin;
      const overLimit = Boolean(project.enforceMaximum) && result.level > finiteNumber(project.maximumLevel, Infinity);
      if (belowDesign) below += 1;
      else if (overLimit) over += 1;
      else compliant += 1;
      if (reserve < minimumReserve) {
        minimumReserve = reserve;
        worstPoint = { ...result, reserve };
      }
      if (result.level > maximumLevel) maximumLevel = result.level;
    }
    const total = assessmentPoints.length;
    return {
      compliant: below === 0 && over === 0,
      compliantCount: compliant,
      compliantPercent: total ? (compliant / total) * 100 : 0,
      belowCount: below,
      overCount: over,
      total,
      minimumReserve,
      maximumLevel,
      worstPoint,
      designMargin,
      sampleSpacing: samples.spacing,
      proposedSources,
    };
  }

  function optimizePlacementGrid(project, deviceKey, rectangle, options = {}) {
    const rect = {
      x: finiteNumber(rectangle && rectangle.x, 0),
      y: finiteNumber(rectangle && rectangle.y, 0),
      width: Math.max(0, finiteNumber(rectangle && rectangle.width, 0)),
      depth: Math.max(0, finiteNumber(rectangle && rectangle.depth, 0)),
    };
    const maxSources = Math.max(1, Math.floor(finiteNumber(options.maxSources, 500)));
    const samples = createPlacementSamples(rect, options.sampleSpacing || project.gridSpacing);
    const emptyGrid = { ...rect, columns: 0, rows: 0, count: 0, spacingX: 0, spacingY: 0, points: [] };
    const existingAssessment = assessPlacementGrid(project, deviceKey, rect, emptyGrid, options, samples);
    if (options.includeExisting !== false && existingAssessment.compliant) {
      return {
        status: "existing-compliant",
        layout: emptyGrid,
        assessment: existingAssessment,
        sampleCount: existingAssessment.total,
        testedLayouts: 0,
      };
    }

    const cache = new Map();
    let testedLayouts = 0;
    let bestEffort = null;
    function evaluateSpacing(nominalSpacing) {
      const columns = Math.max(1, Math.ceil(rect.width / nominalSpacing));
      const rows = Math.max(1, Math.ceil(rect.depth / nominalSpacing));
      if (columns * rows > maxSources) return { limit: true, columns, rows };
      const signature = `${columns}x${rows}`;
      if (cache.has(signature)) return cache.get(signature);
      const layout = createPlacementGrid(rect, columns, rows);
      const assessment = assessPlacementGrid(project, deviceKey, rect, layout, options, samples);
      const trial = { nominalSpacing, layout, assessment, limit: false };
      cache.set(signature, trial);
      testedLayouts += 1;
      if (
        !bestEffort ||
        assessment.compliantPercent > bestEffort.assessment.compliantPercent ||
        (assessment.compliantPercent === bestEffort.assessment.compliantPercent && layout.count < bestEffort.layout.count)
      ) {
        bestEffort = trial;
      }
      return trial;
    }

    const maximumSpacing = Math.max(rect.width, rect.depth, 0.5) * 1.01;
    let nominalSpacing = maximumSpacing;
    let previousFailSpacing = null;
    let firstPass = null;
    for (let step = 0; step < 70; step += 1) {
      const trial = evaluateSpacing(nominalSpacing);
      if (trial.limit) break;
      if (trial.assessment.compliant) {
        firstPass = trial;
        break;
      }
      previousFailSpacing = nominalSpacing;
      nominalSpacing *= 0.9;
    }

    if (!firstPass) {
      return {
        status: "no-solution",
        layout: bestEffort ? bestEffort.layout : emptyGrid,
        assessment: bestEffort ? bestEffort.assessment : existingAssessment,
        sampleCount: bestEffort ? bestEffort.assessment.total : existingAssessment.total,
        testedLayouts,
        maxSources,
      };
    }

    let best = firstPass;
    if (previousFailSpacing != null) {
      let passingSpacing = firstPass.nominalSpacing;
      let failingSpacing = previousFailSpacing;
      for (let step = 0; step < 14; step += 1) {
        const midpoint = (passingSpacing + failingSpacing) / 2;
        const trial = evaluateSpacing(midpoint);
        if (!trial.limit && trial.assessment.compliant) {
          best = trial;
          passingSpacing = midpoint;
        } else {
          failingSpacing = midpoint;
        }
      }
    }

    return {
      status: "calculated",
      layout: best.layout,
      assessment: best.assessment,
      sampleCount: best.assessment.total,
      testedLayouts,
      maxSources,
    };
  }
  function summarizeGrid(grid, project) {
    const finite = grid.points.filter((point) => Number.isFinite(point.level));
    const total = grid.points.length;
    const below = grid.points.filter((point) => point.status === "below").length;
    const compliant = grid.points.filter((point) => point.status === "compliant").length;
    const over = grid.points.filter((point) => point.status === "over").length;
    const empty = total - below - compliant - over;
    const levels = finite.map((point) => point.level);
    const average = levels.length ? energeticSum(levels) - 10 * Math.log10(levels.length) : -Infinity;
    const arithmeticAverage = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : -Infinity;
    const sourceCount = Array.isArray(project.sources) ? project.sources.filter((source) => source.enabled !== false).length : 0;
    const connectedLoad = Array.isArray(project.sources)
      ? project.sources.filter((source) => source.enabled !== false).reduce((sum, source) => sum + Math.max(0, finiteNumber(source.tapPower, 0)), 0)
      : 0;
    const headroom = Math.max(0, finiteNumber(project.amplifierHeadroom, 20));
    return {
      total,
      below,
      compliant,
      over,
      empty,
      compliantPercent: total ? (compliant / total) * 100 : 0,
      audiblePercent: total ? ((compliant + over) / total) * 100 : 0,
      overPercent: total ? (over / total) * 100 : 0,
      minimum: levels.length ? levels.reduce((minimum, level) => Math.min(minimum, level), Infinity) : -Infinity,
      maximum: levels.length ? levels.reduce((maximum, level) => Math.max(maximum, level), -Infinity) : -Infinity,
      energeticAverage: average,
      arithmeticAverage,
      sourceCount,
      connectedLoad,
      amplifierWithHeadroom: connectedLoad * (1 + headroom / 100),
      actualSpacing: grid.spacing,
    };
  }

  function summarizeLoops(project) {
    const loops = new Map();
    const sources = Array.isArray(project.sources) ? project.sources : [];
    for (const source of sources) {
      if (source.enabled === false) continue;
      const name = String(source.loop || "Unassigned").trim() || "Unassigned";
      if (!loops.has(name)) loops.set(name, { name, count: 0, connectedLoad: 0 });
      const entry = loops.get(name);
      entry.count += 1;
      entry.connectedLoad += Math.max(0, finiteNumber(source.tapPower, 0));
    }
    const headroom = Math.max(0, finiteNumber(project.amplifierHeadroom, 20));
    return [...loops.values()]
      .map((entry) => ({ ...entry, withHeadroom: entry.connectedLoad * (1 + headroom / 100) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function instantiateDevice(key, overrides = {}) {
    const preset = DEVICE_PRESETS[key] || DEVICE_PRESETS.custom;
    return {
      id: makeId("source"),
      presetKey: preset.key,
      name: preset.name,
      model: preset.model,
      x: 10,
      y: 10,
      z: preset.sourceHeight,
      azimuth: 0,
      elevation: 0,
      referenceSpl: preset.referenceSpl,
      referenceDistance: preset.referenceDistance,
      referencePower: preset.referencePower,
      tapPower: preset.tapPower,
      ratedPower: preset.ratedPower,
      beamWidth: preset.beamWidth,
      verticalBeamWidth: preset.verticalBeamWidth || 360,
      rearAttenuation: preset.rearAttenuation,
      nearFieldDistance: preset.nearFieldDistance,
      additionalLoss: 0,
      weighting: preset.weighting,
      confidence: preset.confidence,
      provenance: preset.provenance,
      loop: "L1",
      enabled: true,
      ...overrides,
    };
  }

  function createExampleSources(mode, width, depth) {
    if (mode === "siren") {
      return [
        instantiateDevice("siren3200", {
          name: "ESS-01",
          x: width / 2,
          y: depth / 2,
          z: 15,
          loop: "ESS",
        }),
      ];
    }
    const key = mode === "publicAddress" ? "horn25" : "horn25";
    const positions = [
      [width * 0.16, depth * 0.2, 35],
      [width * 0.84, depth * 0.2, 145],
      [width * 0.16, depth * 0.8, 325],
      [width * 0.84, depth * 0.8, 215],
    ];
    return positions.map(([x, y, azimuth], index) =>
      instantiateDevice(key, {
        name: `${mode === "publicAddress" ? "PA" : "IPPS"}-${String(index + 1).padStart(2, "0")}`,
        x,
        y,
        azimuth,
        loop: index < 2 ? "L1" : "L2",
      }),
    );
  }

  function createProject(mode = "paging") {
    const criteria = MODE_CRITERIA[mode] || MODE_CRITERIA.paging;
    const width = mode === "siren" ? 300 : 90;
    const depth = mode === "siren" ? 220 : 60;
    return {
      schemaVersion: 2,
      id: makeId("study"),
      title: "Sound Coverage Study",
      revision: "A",
      preparedBy: "",
      mode,
      weighting: criteria.weighting,
      width,
      depth,
      gridSpacing: mode === "siren" ? 5 : 2,
      receiverHeight: criteria.receiverHeight,
      ambientLevel: criteria.ambientLevel,
      requiredMargin: criteria.requiredMargin,
      minimumLevel: criteria.minimumLevel,
      maximumLevel: criteria.maximumLevel,
      enforceMaximum: criteria.enforceMaximum,
      fixedLoss: criteria.fixedLoss,
      airLossPer100m: 0,
      amplifierHeadroom: 20,
      autoSpacingX: 12,
      autoSpacingY: 12,
      autoPlacementMethod: "compliance",
      autoDesignMargin: 3,
      autoBaseAzimuth: 0,
      autoAlternateAzimuth: true,
      autoIncludeExisting: true,
      viewMode: "compliance",
      showGrid: true,
      showNoiseZones: true,
      showLabels: true,
      showBeams: true,
      heatmapOpacity: 0.68,
      backgroundImage: "",
      backgroundName: "",
      backgroundOpacity: 0.35,
      backgroundVisible: true,
      backgroundScaleDenominator: 200,
      backgroundDpi: 96,
      backgroundPixelWidth: 0,
      backgroundPixelHeight: 0,
      sources: createExampleSources(mode, width, depth),
      noiseZones: [],
      obstacles: [],
      notes: "Screening study based on repository criteria. Verify device data and final coverage with approved acoustic software and field testing.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function applyModeCriteria(project, mode) {
    const criteria = MODE_CRITERIA[mode] || MODE_CRITERIA.paging;
    return {
      ...project,
      mode,
      weighting: criteria.weighting,
      receiverHeight: criteria.receiverHeight,
      ambientLevel: criteria.ambientLevel,
      requiredMargin: criteria.requiredMargin,
      minimumLevel: criteria.minimumLevel,
      maximumLevel: criteria.maximumLevel,
      enforceMaximum: criteria.enforceMaximum,
      fixedLoss: criteria.fixedLoss,
      updatedAt: new Date().toISOString(),
    };
  }

  function pointSegmentDistance(point, start, end) {
    const px = finiteNumber(point && point.x, 0);
    const py = finiteNumber(point && point.y, 0);
    const x0 = finiteNumber(start && start.x, 0);
    const y0 = finiteNumber(start && start.y, 0);
    const x1 = finiteNumber(end && end.x, x0);
    const y1 = finiteNumber(end && end.y, y0);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= EPSILON) return Math.hypot(px - x0, py - y0);
    const position = clamp(((px - x0) * dx + (py - y0) * dy) / lengthSquared, 0, 1);
    return Math.hypot(px - (x0 + position * dx), py - (y0 + position * dy));
  }

  function sourceIdsInsideRectangle(sources, rectangle) {
    const x0 = finiteNumber(rectangle && rectangle.x, 0);
    const y0 = finiteNumber(rectangle && rectangle.y, 0);
    const x1 = x0 + finiteNumber(rectangle && rectangle.width, 0);
    const y1 = y0 + finiteNumber(rectangle && rectangle.depth, 0);
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    return (Array.isArray(sources) ? sources : [])
      .filter((source) => {
        const x = finiteNumber(source && source.x, Infinity);
        const y = finiteNumber(source && source.y, Infinity);
        return x >= left && x <= right && y >= top && y <= bottom;
      })
      .map((source) => source.id);
  }

  function applySourceBatchEdits(sources, edits = {}) {
    const items = (Array.isArray(sources) ? sources : []).filter((source) => source && typeof source === "object");
    const has = (key) => Object.prototype.hasOwnProperty.call(edits, key);
    const numericFields = {
      z: [0, 1000],
      elevation: [-90, 90],
      referenceSpl: [0, 180],
      referenceDistance: [0.001, 10000],
      referencePower: [0.001, 100000],
      ratedPower: [0.001, 100000],
      tapPower: [0.001, 100000],
      nearFieldDistance: [0.1, 10000],
      beamWidth: [1, 360],
      verticalBeamWidth: [1, 360],
      rearAttenuation: [0, 100],
      additionalLoss: [0, 100],
    };

    items.forEach((source) => {
      if (has("azimuth") && Number.isFinite(Number(edits.azimuth))) {
        const value = Number(edits.azimuth);
        source.azimuth = normalizeAngle(edits.azimuthMode === "offset" ? finiteNumber(source.azimuth, 0) + value : value);
      }
      Object.entries(numericFields).forEach(([key, [minimum, maximum]]) => {
        if (!has(key) || !Number.isFinite(Number(edits[key]))) return;
        source[key] = clamp(Number(edits[key]), minimum, maximum);
      });
      if (has("ratedPower") || has("tapPower")) {
        source.tapPower = Math.min(Math.max(0.001, finiteNumber(source.tapPower, 0.001)), Math.max(0.001, finiteNumber(source.ratedPower, source.tapPower)));
      }
      if (has("loop")) source.loop = String(edits.loop ?? "").slice(0, 120);
      if (has("enabled") && typeof edits.enabled === "boolean") source.enabled = edits.enabled;
    });
    return items.length;
  }

  function removeProjectObjects(project, selections) {
    if (!project || typeof project !== "object" || !Array.isArray(selections)) return 0;
    const keys = new Set(selections
      .filter((selection) => selection && ["source", "noise", "obstacle"].includes(selection.type))
      .map((selection) => `${selection.type}:${String(selection.id ?? "")}`));
    let removed = 0;
    [["source", "sources"], ["noise", "noiseZones"], ["obstacle", "obstacles"]].forEach(([type, property]) => {
      const items = Array.isArray(project[property]) ? project[property] : [];
      const retained = items.filter((item) => !keys.has(`${type}:${String(item.id ?? "")}`));
      removed += items.length - retained.length;
      project[property] = retained;
    });
    return removed;
  }

  function safeText(value, fallback = "", maximumLength = 500) {
    return (typeof value === "string" ? value : String(fallback ?? "")).slice(0, maximumLength);
  }

  function sanitizeSource(input, projectWidth, projectDepth) {
    const value = input && typeof input === "object" ? input : {};
    const presetKey = typeof value.presetKey === "string" && DEVICE_PRESETS[value.presetKey] ? value.presetKey : "custom";
    const base = instantiateDevice(presetKey);
    const weighting = ["A", "C", "Z"].includes(value.weighting) ? value.weighting : base.weighting;
    return {
      id: safeText(value.id, makeId("source"), 160) || makeId("source"),
      presetKey: base.presetKey,
      name: safeText(value.name, base.name, 200),
      model: safeText(value.model, base.model, 200),
      x: clamp(finiteNumber(value.x, base.x), 0, projectWidth),
      y: clamp(finiteNumber(value.y, base.y), 0, projectDepth),
      z: clamp(finiteNumber(value.z, base.z), 0, 1000),
      azimuth: normalizeAngle(finiteNumber(value.azimuth, base.azimuth)),
      elevation: clamp(finiteNumber(value.elevation, base.elevation), -90, 90),
      referenceSpl: clamp(finiteNumber(value.referenceSpl, base.referenceSpl), 0, 180),
      referenceDistance: clamp(finiteNumber(value.referenceDistance, base.referenceDistance), 0.01, 10000),
      referencePower: clamp(finiteNumber(value.referencePower, base.referencePower), 0.000001, 1000000),
      tapPower: clamp(finiteNumber(value.tapPower, base.tapPower), 0.000001, 1000000),
      ratedPower: clamp(finiteNumber(value.ratedPower, base.ratedPower), 0.000001, 1000000),
      beamWidth: clamp(finiteNumber(value.beamWidth, base.beamWidth), 1, 360),
      verticalBeamWidth: clamp(finiteNumber(value.verticalBeamWidth, base.verticalBeamWidth), 1, 360),
      rearAttenuation: clamp(finiteNumber(value.rearAttenuation, base.rearAttenuation), 0, 100),
      nearFieldDistance: clamp(finiteNumber(value.nearFieldDistance, base.nearFieldDistance), 0.01, 10000),
      additionalLoss: clamp(finiteNumber(value.additionalLoss, base.additionalLoss), 0, 100),
      weighting,
      confidence: base.confidence,
      provenance: safeText(value.provenance, base.provenance, 2000),
      loop: safeText(value.loop, base.loop, 120),
      enabled: value.enabled !== false,
    };
  }

  function sanitizeNoiseZone(input, projectWidth, projectDepth) {
    const value = input && typeof input === "object" ? input : {};
    const x = clamp(finiteNumber(value.x, 0), 0, Math.max(0, projectWidth - 0.1));
    const y = clamp(finiteNumber(value.y, 0), 0, Math.max(0, projectDepth - 0.1));
    return {
      id: safeText(value.id, makeId("noise"), 160) || makeId("noise"),
      name: safeText(value.name, "Noise zone", 200),
      x,
      y,
      width: clamp(finiteNumber(value.width, 10), 0.1, Math.max(0.1, projectWidth - x)),
      depth: clamp(finiteNumber(value.depth, 10), 0.1, Math.max(0.1, projectDepth - y)),
      level: clamp(finiteNumber(value.level, 60), 0, 180),
      enabled: value.enabled !== false,
    };
  }

  function sanitizeObstacle(input, projectWidth, projectDepth) {
    const value = input && typeof input === "object" ? input : {};
    const x = clamp(finiteNumber(value.x, 0), 0, Math.max(0, projectWidth - 0.1));
    const y = clamp(finiteNumber(value.y, 0), 0, Math.max(0, projectDepth - 0.1));
    return {
      id: safeText(value.id, makeId("obstacle"), 160) || makeId("obstacle"),
      name: safeText(value.name, "Obstacle", 200),
      x,
      y,
      width: clamp(finiteNumber(value.width, 10), 0.1, Math.max(0.1, projectWidth - x)),
      depth: clamp(finiteNumber(value.depth, 10), 0.1, Math.max(0.1, projectDepth - y)),
      height: clamp(finiteNumber(value.height, 6), 0, 1000),
      loss: clamp(finiteNumber(value.loss, 10), 0, 100),
      enabled: value.enabled !== false,
    };
  }

  function sanitizeProject(input) {
    const mode = input && MODE_CRITERIA[input.mode] ? input.mode : "paging";
    const fallback = createProject(mode);
    if (!input || typeof input !== "object") return fallback;
    const width = clamp(finiteNumber(input.width, fallback.width), 1, 10000);
    const depth = clamp(finiteNumber(input.depth, fallback.depth), 1, 10000);
    const inputSchema = Math.floor(finiteNumber(input.schemaVersion, 1));
    const legacyDefaultLoss = inputSchema < 2 && finiteNumber(input.fixedLoss, 1) === 1;
    const weighting = ["A", "C", "Z"].includes(input.weighting) ? input.weighting : fallback.weighting;
    const viewMode = ["compliance", "level", "margin"].includes(input.viewMode) ? input.viewMode : fallback.viewMode;
    return {
      ...fallback,
      schemaVersion: 2,
      id: safeText(input.id, fallback.id, 160) || fallback.id,
      title: safeText(input.title, fallback.title, 300),
      revision: safeText(input.revision, fallback.revision, 80),
      preparedBy: safeText(input.preparedBy, fallback.preparedBy, 200),
      mode,
      weighting,
      width,
      depth,
      gridSpacing: clamp(finiteNumber(input.gridSpacing, fallback.gridSpacing), 0.25, 1000),
      receiverHeight: clamp(finiteNumber(input.receiverHeight, fallback.receiverHeight), 0, 1000),
      ambientLevel: clamp(finiteNumber(input.ambientLevel, fallback.ambientLevel), 0, 180),
      requiredMargin: clamp(finiteNumber(input.requiredMargin, fallback.requiredMargin), 0, 60),
      minimumLevel: clamp(finiteNumber(input.minimumLevel, fallback.minimumLevel), 0, 180),
      maximumLevel: clamp(finiteNumber(input.maximumLevel, fallback.maximumLevel), 0, 180),
      enforceMaximum: input.enforceMaximum == null ? fallback.enforceMaximum : Boolean(input.enforceMaximum),
      fixedLoss: legacyDefaultLoss ? 0 : clamp(finiteNumber(input.fixedLoss, fallback.fixedLoss), 0, 100),
      airLossPer100m: clamp(finiteNumber(input.airLossPer100m, fallback.airLossPer100m), 0, 100),
      amplifierHeadroom: clamp(finiteNumber(input.amplifierHeadroom, fallback.amplifierHeadroom), 0, 500),
      autoSpacingX: clamp(finiteNumber(input.autoSpacingX, fallback.autoSpacingX), 0.5, 1000),
      autoSpacingY: clamp(finiteNumber(input.autoSpacingY, fallback.autoSpacingY), 0.5, 1000),
      autoPlacementMethod: input.autoPlacementMethod === "manual" ? "manual" : "compliance",
      autoDesignMargin: clamp(finiteNumber(input.autoDesignMargin, fallback.autoDesignMargin), 0, 20),
      autoBaseAzimuth: normalizeAngle(finiteNumber(input.autoBaseAzimuth, fallback.autoBaseAzimuth)),
      autoAlternateAzimuth: input.autoAlternateAzimuth !== false,
      autoIncludeExisting: input.autoIncludeExisting !== false,
      viewMode,
      showGrid: input.showGrid !== false,
      showNoiseZones: input.showNoiseZones !== false,
      showLabels: input.showLabels !== false,
      showBeams: input.showBeams !== false,
      heatmapOpacity: clamp(finiteNumber(input.heatmapOpacity, fallback.heatmapOpacity), 0.1, 1),
      backgroundImage: safeText(input.backgroundImage, "", 12000000),
      backgroundName: safeText(input.backgroundName, "", 260),
      backgroundOpacity: clamp(finiteNumber(input.backgroundOpacity, fallback.backgroundOpacity), 0, 1),
      backgroundVisible: input.backgroundVisible !== false,
      backgroundScaleDenominator: clamp(finiteNumber(input.backgroundScaleDenominator, fallback.backgroundScaleDenominator), 1, 1000000),
      backgroundDpi: clamp(finiteNumber(input.backgroundDpi, fallback.backgroundDpi), 10, 2400),
      backgroundPixelWidth: clamp(finiteNumber(input.backgroundPixelWidth, fallback.backgroundPixelWidth), 0, 100000),
      backgroundPixelHeight: clamp(finiteNumber(input.backgroundPixelHeight, fallback.backgroundPixelHeight), 0, 100000),
      sources: Array.isArray(input.sources)
        ? input.sources.filter((item) => item && typeof item === "object").slice(0, 2000).map((item) => sanitizeSource(item, width, depth))
        : fallback.sources,
      noiseZones: Array.isArray(input.noiseZones)
        ? input.noiseZones.filter((item) => item && typeof item === "object").slice(0, 1000).map((item) => sanitizeNoiseZone(item, width, depth))
        : fallback.noiseZones,
      obstacles: Array.isArray(input.obstacles)
        ? input.obstacles.filter((item) => item && typeof item === "object").slice(0, 1000).map((item) => sanitizeObstacle(item, width, depth))
        : fallback.obstacles,
      notes: safeText(input.notes, fallback.notes, 10000),
      createdAt: safeText(input.createdAt, fallback.createdAt, 80),
      updatedAt: new Date().toISOString(),
    };
  }
  return Object.freeze({
    MODE_CRITERIA,
    DEVICE_PRESETS,
    MAX_GRID_CELLS,
    MAX_AUTO_SAMPLES,
    clamp,
    finiteNumber,
    makeId,
    degreesToRadians,
    normalizeAngle,
    smallestAngleDifference,
    energeticSum,
    beamPlaneLoss,
    directivityLoss,
    segmentRectangleInterval,
    obstacleLoss,
    sourceLevelAtPoint,
    noiseAtPoint,
    targetForNoise,
    calculatePoint,
    calculateGrid,
    createPlacementGrid,
    createPlacementSamples,
    createPlacementSources,
    assessPlacementGrid,
    optimizePlacementGrid,
    summarizeGrid,
    summarizeLoops,
    pointSegmentDistance,
    sourceIdsInsideRectangle,
    applySourceBatchEdits,
    removeProjectObjects,
    instantiateDevice,
    createProject,
    applyModeCriteria,
    sanitizeProject,
  });
});
