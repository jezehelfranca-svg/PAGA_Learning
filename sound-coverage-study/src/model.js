(function attachSoundCoverageModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SoundCoverageModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createModel() {
  "use strict";

  const EPSILON = 1e-9;
  const MAX_GRID_CELLS = 30000;

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
      fixedLoss: 1,
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
      fixedLoss: 1,
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
      fixedLoss: 1,
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

  function directivityLoss(source, x, y) {
    const beamWidth = clamp(finiteNumber(source.beamWidth, 360), 1, 360);
    const rear = Math.max(0, finiteNumber(source.rearAttenuation, 0));
    if (beamWidth >= 359.9 || rear <= EPSILON) return 0;

    const difference = smallestAngleDifference(source.azimuth, sourceBearing(source, x, y));
    const edge = Math.max(0.5, beamWidth / 2);
    if (difference <= edge) {
      return Math.min(rear, 6 * (difference / edge) ** 2);
    }
    const tailSpan = Math.max(0.5, 180 - edge);
    return Math.min(rear, 6 + (rear - 6) * ((difference - edge) / tailSpan));
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
    const directionAdjustment = directivityLoss(source, x, y);
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
      if (inside) ambient = finiteNumber(zone.level, ambient);
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
      minimum: levels.length ? Math.min(...levels) : -Infinity,
      maximum: levels.length ? Math.max(...levels) : -Infinity,
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
      referenceSpl: preset.referenceSpl,
      referenceDistance: preset.referenceDistance,
      referencePower: preset.referencePower,
      tapPower: preset.tapPower,
      ratedPower: preset.ratedPower,
      beamWidth: preset.beamWidth,
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
      schemaVersion: 1,
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
      viewMode: "compliance",
      showGrid: true,
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

  function sanitizeProject(input) {
    const fallback = createProject(input && MODE_CRITERIA[input.mode] ? input.mode : "paging");
    if (!input || typeof input !== "object") return fallback;
    return {
      ...fallback,
      ...input,
      schemaVersion: 1,
      width: clamp(finiteNumber(input.width, fallback.width), 1, 10000),
      depth: clamp(finiteNumber(input.depth, fallback.depth), 1, 10000),
      gridSpacing: clamp(finiteNumber(input.gridSpacing, fallback.gridSpacing), 0.25, 1000),
      receiverHeight: clamp(finiteNumber(input.receiverHeight, fallback.receiverHeight), 0, 1000),
      ambientLevel: clamp(finiteNumber(input.ambientLevel, fallback.ambientLevel), 0, 180),
      requiredMargin: clamp(finiteNumber(input.requiredMargin, fallback.requiredMargin), 0, 60),
      minimumLevel: clamp(finiteNumber(input.minimumLevel, fallback.minimumLevel), 0, 180),
      maximumLevel: clamp(finiteNumber(input.maximumLevel, fallback.maximumLevel), 0, 180),
      fixedLoss: clamp(finiteNumber(input.fixedLoss, fallback.fixedLoss), 0, 100),
      airLossPer100m: clamp(finiteNumber(input.airLossPer100m, fallback.airLossPer100m), 0, 100),
      amplifierHeadroom: clamp(finiteNumber(input.amplifierHeadroom, fallback.amplifierHeadroom), 0, 500),
      backgroundScaleDenominator: clamp(finiteNumber(input.backgroundScaleDenominator, fallback.backgroundScaleDenominator), 1, 1000000),
      backgroundDpi: clamp(finiteNumber(input.backgroundDpi, fallback.backgroundDpi), 10, 2400),
      backgroundPixelWidth: Math.max(0, finiteNumber(input.backgroundPixelWidth, fallback.backgroundPixelWidth)),
      backgroundPixelHeight: Math.max(0, finiteNumber(input.backgroundPixelHeight, fallback.backgroundPixelHeight)),
      sources: Array.isArray(input.sources) ? input.sources.map((source) => ({ ...instantiateDevice(source.presetKey || "custom"), ...source })) : fallback.sources,
      noiseZones: Array.isArray(input.noiseZones) ? input.noiseZones : [],
      obstacles: Array.isArray(input.obstacles) ? input.obstacles : [],
      updatedAt: new Date().toISOString(),
    };
  }

  return Object.freeze({
    MODE_CRITERIA,
    DEVICE_PRESETS,
    MAX_GRID_CELLS,
    clamp,
    finiteNumber,
    makeId,
    degreesToRadians,
    normalizeAngle,
    smallestAngleDifference,
    energeticSum,
    directivityLoss,
    segmentRectangleInterval,
    obstacleLoss,
    sourceLevelAtPoint,
    noiseAtPoint,
    targetForNoise,
    calculatePoint,
    calculateGrid,
    summarizeGrid,
    summarizeLoops,
    instantiateDevice,
    createProject,
    applyModeCriteria,
    sanitizeProject,
  });
});
