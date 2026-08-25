(function initializeSoundCoverageApp() {
  "use strict";

  const Model = window.SoundCoverageModel;
  if (!Model) throw new Error("SoundCoverageModel failed to load.");

  const STORAGE_KEY = "paga-sound-coverage-study-v1";
  const ROTATION_HANDLE_DISTANCE = 25;
  const ROTATION_HANDLE_HIT_RADIUS = 9;
  const canvas = document.getElementById("coverageCanvas");
  const canvasCard = document.getElementById("canvasCard");
  const context = canvas.getContext("2d", { alpha: true });
  const inspector = document.getElementById("selectionInspector");
  const objectList = document.getElementById("objectList");
  const mapTooltip = document.getElementById("mapTooltip");
  const toast = document.getElementById("toast");
  const referencesDialog = document.getElementById("referencesDialog");
  const confirmDialog = document.getElementById("confirmDialog");

  let project = loadProject();
  let grid = null;
  let summary = null;
  let selected = null;
  let placementMode = null;
  let dragging = null;
  let layout = null;
  let backgroundImage = null;
  let backgroundLoadToken = 0;
  let renderFrame = 0;
  let saveTimer = 0;
  let toastTimer = 0;
  let measurementMode = false;
  let measurement = null;

  function loadProject() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? Model.sanitizeProject(JSON.parse(stored)) : Model.createProject("paging");
    } catch (error) {
      console.warn("Could not restore the local project", error);
      return Model.createProject("paging");
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function round(value, digits = 1) {
    if (!Number.isFinite(value)) return "—";
    return Number(value).toFixed(digits);
  }

  function decibelUnit() {
    return `dB${project.weighting || ""}`;
  }

  function debounceSave() {
    window.clearTimeout(saveTimer);
    document.getElementById("saveStatus").textContent = "Saving…";
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        document.getElementById("saveStatus").textContent = "Saved locally";
      } catch (error) {
        console.warn("Local save failed", error);
        document.getElementById("saveStatus").textContent = "Local save unavailable";
      }
    }, 260);
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  function markChanged({ syncControls = false, refreshInspector = true } = {}) {
    project.updatedAt = new Date().toISOString();
    if (syncControls) syncProjectControls();
    recalculate();
    renderObjectList();
    if (refreshInspector) renderInspector();
    debounceSave();
  }

  function recalculate() {
    grid = Model.calculateGrid(project);
    summary = Model.summarizeGrid(grid, project);
    updateMetrics();
    updateCriteriaDisplay();
    scheduleCanvasRender();
  }

  function scheduleCanvasRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      renderCanvas();
    });
  }

  function syncProjectControls() {
    document.querySelectorAll("[data-project-field]").forEach((control) => {
      const key = control.dataset.projectField;
      if (!(key in project)) return;
      if (control.type === "checkbox") control.checked = Boolean(project[key]);
      else control.value = project[key] ?? "";
    });

    document.querySelectorAll(".mode-option").forEach((button) => {
      const active = button.dataset.mode === project.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    document.getElementById("viewModeSelect").value = project.viewMode || "compliance";
    syncToggle("gridToggle", project.showGrid);
    syncToggle("beamToggle", project.showBeams);
    syncToggle("labelToggle", project.showLabels);
    document.getElementById("backgroundOpacityRow").hidden = !project.backgroundImage;
    document.getElementById("backgroundName").textContent = project.backgroundName || "PNG, JPG, WEBP or SVG";
    updatePlanCalibrationUI();
    loadBackgroundImage();
  }

  function syncToggle(id, active) {
    const button = document.getElementById(id);
    button.classList.toggle("active", Boolean(active));
    button.setAttribute("aria-pressed", String(Boolean(active)));
  }
  function calibrationMetrics(scaleDenominator = project.backgroundScaleDenominator, dpi = project.backgroundDpi) {
    const pixelWidth = backgroundImage?.naturalWidth || Number(project.backgroundPixelWidth) || 0;
    const pixelHeight = backgroundImage?.naturalHeight || Number(project.backgroundPixelHeight) || 0;
    const pixelsPerMetre = (Number(dpi) * 39.3700787) / Number(scaleDenominator);
    return {
      pixelWidth,
      pixelHeight,
      pixelsPerMetre,
      width: pixelsPerMetre > 0 ? pixelWidth / pixelsPerMetre : 0,
      depth: pixelsPerMetre > 0 ? pixelHeight / pixelsPerMetre : 0,
    };
  }

  function updatePlanCalibrationUI() {
    const panel = document.getElementById("planCalibrationPanel");
    if (!panel) return;
    panel.hidden = !project.backgroundImage;
    document.getElementById("backgroundScaleDenominator").value = project.backgroundScaleDenominator || 200;
    document.getElementById("backgroundDpi").value = project.backgroundDpi || 96;
    const metrics = calibrationMetrics();
    document.getElementById("backgroundPixelSize").textContent = metrics.pixelWidth
      ? `${metrics.pixelWidth} x ${metrics.pixelHeight} px`
      : "Image size -";
    document.getElementById("calibrationSummary").innerHTML = metrics.pixelWidth
      ? `At <b>1:${round(project.backgroundScaleDenominator, 0)}</b>, 1 m = <b>${round(metrics.pixelsPerMetre, 2)} px</b>. Applying gives <b>${round(metrics.width, 2)} x ${round(metrics.depth, 2)} m</b>.`
      : "Reading image dimensions.";
    updateMeasurementReadout();
  }

  function resizeStudyGeometry(newWidth, newDepth) {
    const ratioX = newWidth / Math.max(project.width, 0.001);
    const ratioY = newDepth / Math.max(project.depth, 0.001);
    project.sources.forEach((item) => {
      item.x *= ratioX;
      item.y *= ratioY;
    });
    [...project.noiseZones, ...project.obstacles].forEach((item) => {
      item.x *= ratioX;
      item.y *= ratioY;
      item.width *= ratioX;
      item.depth *= ratioY;
    });
    project.width = Number(newWidth.toFixed(3));
    project.depth = Number(newDepth.toFixed(3));
  }

  function applyDrawingScale() {
    if (!project.backgroundImage) {
      showToast("Load a plan background before applying a drawing scale.");
      return;
    }
    const scaleDenominator = Number(document.getElementById("backgroundScaleDenominator").value);
    const dpi = Number(document.getElementById("backgroundDpi").value);
    if (!Number.isFinite(scaleDenominator) || scaleDenominator <= 0 || !Number.isFinite(dpi) || dpi < 10) {
      showToast("Enter a valid scale denominator and raster DPI.");
      return;
    }
    const metrics = calibrationMetrics(scaleDenominator, dpi);
    if (!metrics.pixelWidth) {
      showToast("The image dimensions are still loading.");
      return;
    }
    if (metrics.width < 1 || metrics.depth < 1 || metrics.width > 10000 || metrics.depth > 10000) {
      showToast("This scale produces dimensions outside the supported 1-10,000 m range.");
      return;
    }
    project.backgroundScaleDenominator = Model.clamp(scaleDenominator, 1, 1000000);
    project.backgroundDpi = Model.clamp(dpi, 10, 2400);
    resizeStudyGeometry(metrics.width, metrics.depth);
    measurement = null;
    markChanged({ syncControls: true });
    showToast(`Scale 1:${round(scaleDenominator, 0)} applied ; ${round(metrics.pixelsPerMetre, 2)} px per metre.`);
  }

  function updateMeasurementReadout() {
    const readout = document.getElementById("measurementReadout");
    if (!readout) return;
    if (!measurement?.start || !measurement?.end) {
      readout.hidden = true;
      return;
    }
    const distance = Math.hypot(measurement.end.x - measurement.start.x, measurement.end.y - measurement.start.y);
    if (distance <= 0) {
      readout.hidden = true;
      return;
    }
    const denominator = Number(project.backgroundScaleDenominator) || 1;
    const paperMillimetres = (distance * 1000) / denominator;
    readout.hidden = false;
    readout.textContent = `Measured ${round(distance, 2)} m ; ${round(paperMillimetres, 1)} mm on paper at 1:${round(denominator, 0)}`;
  }

  function setMeasurementMode(active, { clear = active } = {}) {
    measurementMode = Boolean(active);
    if (measurementMode) {
      placementMode = null;
      document.getElementById("placeSourceButton").classList.remove("placing");
      document.getElementById("addNoiseZoneButton").classList.remove("placing");
      document.getElementById("addObstacleButton").classList.remove("placing");
      canvas.classList.remove("placing");
    }
    if (clear) measurement = null;
    const button = document.getElementById("measureButton");
    button.classList.toggle("measuring", measurementMode);
    button.setAttribute("aria-pressed", String(measurementMode));
    canvas.classList.toggle("measuring", measurementMode);
    canvas.style.cursor = "";
    document.getElementById("mapHint").textContent = measurementMode
      ? "Measure ; click the first point"
      : "Drag symbol to move ; drag its round handle to rotate ; hold Shift to snap 15 degrees";
    updateMeasurementReadout();
    scheduleCanvasRender();
  }

  function updateCriteriaDisplay() {
    const criteria = Model.MODE_CRITERIA[project.mode] || Model.MODE_CRITERIA.paging;
    const unit = decibelUnit();
    document.getElementById("modeChip").textContent = `${criteria.shortLabel} · ${unit}`;
    document.getElementById("ambientUnit").textContent = unit;
    document.getElementById("minimumUnit").textContent = unit;
    document.getElementById("maximumUnit").textContent = unit;
    document.getElementById("averageUnit").textContent = unit;
    document.getElementById("criteriaNote").innerHTML = `<b>${escapeHtml(criteria.label)}</b>${escapeHtml(criteria.note)}<br><small>${escapeHtml(criteria.sourceRef)}</small>`;
    document.getElementById("xAxisLabel").textContent = `${round(project.width, project.width % 1 ? 1 : 0)} m`;
    document.getElementById("yAxisLabel").textContent = `${round(project.depth, project.depth % 1 ? 1 : 0)} m`;
  }

  function updateMetrics() {
    const unit = decibelUnit();
    document.getElementById("compliantPercent").textContent = round(summary.compliantPercent, 0);
    document.getElementById("complianceProgress").style.width = `${Model.clamp(summary.compliantPercent, 0, 100)}%`;
    document.getElementById("audibleSummary").textContent = `${round(summary.audiblePercent, 0)}% meets the minimum target`;
    document.getElementById("averageSpl").textContent = round(summary.arithmeticAverage, 1);
    document.getElementById("splRange").textContent = Number.isFinite(summary.minimum)
      ? `Range ${round(summary.minimum, 1)}–${round(summary.maximum, 1)} ${unit}`
      : "Place a source to calculate";
    document.getElementById("sourceCount").textContent = String(summary.sourceCount);
    document.getElementById("connectedLoad").textContent = `${round(summary.connectedLoad, summary.connectedLoad % 1 ? 1 : 0)} W connected · ${round(summary.amplifierWithHeadroom, 0)} W incl. spare`;
    document.getElementById("overPercent").textContent = project.enforceMaximum ? round(summary.overPercent, 1) : "N/A";
    document.getElementById("gridResolution").textContent = `${grid.points.length.toLocaleString()} samples · ${round(grid.spacing, 2)} m grid`;
    document.getElementById("mapEmpty").hidden = summary.sourceCount > 0;
  }

  function populateDevicePresets() {
    const select = document.getElementById("devicePresetSelect");
    select.innerHTML = Object.values(Model.DEVICE_PRESETS)
      .map((preset) => `<option value="${escapeHtml(preset.key)}">${escapeHtml(preset.name)}</option>`)
      .join("");
    select.value = project.mode === "siren" ? "siren3200" : "horn25";
  }

  function loadBackgroundImage() {
    backgroundLoadToken += 1;
    const token = backgroundLoadToken;
    backgroundImage = null;
    if (!project.backgroundImage) {
      scheduleCanvasRender();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (token !== backgroundLoadToken) return;
      backgroundImage = image;
      const dimensionsChanged = project.backgroundPixelWidth !== image.naturalWidth || project.backgroundPixelHeight !== image.naturalHeight;
      project.backgroundPixelWidth = image.naturalWidth;
      project.backgroundPixelHeight = image.naturalHeight;
      updatePlanCalibrationUI();
      if (dimensionsChanged) debounceSave();
      scheduleCanvasRender();
    };
    image.onerror = () => {
      if (token !== backgroundLoadToken) return;
      showToast("The plan image could not be loaded.");
    };
    image.src = project.backgroundImage;
  }

  function computeLayout(cssWidth, cssHeight) {
    const padding = { left: 46, right: 30, top: 40, bottom: 38 };
    const availableWidth = Math.max(1, cssWidth - padding.left - padding.right);
    const availableHeight = Math.max(1, cssHeight - padding.top - padding.bottom);
    const scale = Math.min(availableWidth / project.width, availableHeight / project.depth);
    const planWidth = project.width * scale;
    const planHeight = project.depth * scale;
    return {
      cssWidth,
      cssHeight,
      scale,
      left: padding.left + (availableWidth - planWidth) / 2,
      top: padding.top + (availableHeight - planHeight) / 2,
      planWidth,
      planHeight,
    };
  }

  function planToCanvas(x, y) {
    return {
      x: layout.left + x * layout.scale,
      y: layout.top + y * layout.scale,
    };
  }

  function canvasToPlan(x, y) {
    return {
      x: Model.clamp((x - layout.left) / layout.scale, 0, project.width),
      y: Model.clamp((y - layout.top) / layout.scale, 0, project.depth),
    };
  }

  function rotationHandlePosition(source) {
    const position = planToCanvas(source.x, source.y);
    const angle = Model.degreesToRadians(source.azimuth);
    return {
      x: position.x + Math.cos(angle) * ROTATION_HANDLE_DISTANCE,
      y: position.y + Math.sin(angle) * ROTATION_HANDLE_DISTANCE,
    };
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = computeLayout(rect.width, rect.height);
    return { width: rect.width, height: rect.height };
  }

  function rgba(hex, alpha) {
    const cleaned = hex.replace("#", "");
    const value = Number.parseInt(cleaned.length === 3 ? cleaned.split("").map((part) => part + part).join("") : cleaned, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function interpolateColor(stops, value) {
    const normalized = Model.clamp(value, 0, 1);
    const scaled = normalized * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(scaled));
    const amount = scaled - index;
    const parse = (hex) => {
      const number = Number.parseInt(hex.slice(1), 16);
      return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
    };
    const a = parse(stops[index]);
    const b = parse(stops[index + 1]);
    return `rgb(${a.map((channel, position) => Math.round(channel + (b[position] - channel) * amount)).join(",")})`;
  }

  function pointColor(point) {
    if (!Number.isFinite(point.level)) return "rgba(230,235,230,0.55)";
    if (project.viewMode === "compliance") {
      if (point.status === "below") return "#cf5a5e";
      if (point.status === "over") return "#d58a32";
      return "#4ba67d";
    }
    if (project.viewMode === "margin") {
      return interpolateColor(["#b84650", "#e29b52", "#e8d771", "#7ebc75", "#238668"], (point.margin + 15) / 35);
    }
    const lower = Math.max(35, Math.min(project.ambientLevel - 10, project.minimumLevel || project.ambientLevel));
    const upper = Math.max(lower + 25, project.maximumLevel || lower + 45, summary.maximum || lower + 45);
    return interpolateColor(["#315c92", "#40aeb0", "#a6d96a", "#f2cf5b", "#d95752"], (point.level - lower) / (upper - lower));
  }

  function renderCanvas() {
    const size = resizeCanvas();
    context.clearRect(0, 0, size.width, size.height);

    context.save();
    context.fillStyle = "#f8f6ed";
    context.fillRect(layout.left, layout.top, layout.planWidth, layout.planHeight);
    context.clip(new Path2D(`M${layout.left},${layout.top}h${layout.planWidth}v${layout.planHeight}h-${layout.planWidth}z`));

    if (backgroundImage) {
      context.save();
      context.globalAlpha = Model.clamp(Number(project.backgroundOpacity), 0, 1);
      context.drawImage(backgroundImage, layout.left, layout.top, layout.planWidth, layout.planHeight);
      context.restore();
    }

    drawNoiseZones(true);
    drawHeatmap();
    drawObstacles();
    if (project.showGrid) drawGrid();
    drawNoiseZones(false);
    if (project.showBeams) drawBeams();
    drawSources();
    context.restore();

    context.save();
    context.strokeStyle = "rgba(13,55,56,0.55)";
    context.lineWidth = 1.4;
    context.strokeRect(layout.left, layout.top, layout.planWidth, layout.planHeight);
    drawScaleBar();
    drawMeasurement();
    context.restore();
    renderLegend();
  }

  function drawHeatmap() {
    context.save();
    context.globalAlpha = Model.clamp(Number(project.heatmapOpacity), 0.1, 1);
    const cellWidth = grid.cellWidth * layout.scale + 0.6;
    const cellHeight = grid.cellDepth * layout.scale + 0.6;
    for (const point of grid.points) {
      const position = planToCanvas(point.x - grid.cellWidth / 2, point.y - grid.cellDepth / 2);
      context.fillStyle = pointColor(point);
      context.fillRect(position.x, position.y, cellWidth, cellHeight);
    }
    context.restore();
  }

  function drawGrid() {
    const desiredPixels = 58;
    const rawStep = desiredPixels / layout.scale;
    const exponent = 10 ** Math.floor(Math.log10(Math.max(rawStep, 0.001)));
    const normalized = rawStep / exponent;
    const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    const step = multiple * exponent;
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = "rgba(21,58,59,0.13)";
    context.fillStyle = "rgba(21,58,59,0.58)";
    context.font = "9px Segoe UI, sans-serif";
    for (let x = 0; x <= project.width + 0.001; x += step) {
      const a = planToCanvas(x, 0);
      const b = planToCanvas(x, project.depth);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      if (x > 0 && x < project.width) context.fillText(`${round(x, x % 1 ? 1 : 0)}`, a.x + 3, layout.top + 12);
    }
    for (let y = 0; y <= project.depth + 0.001; y += step) {
      const a = planToCanvas(0, y);
      const b = planToCanvas(project.width, y);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      if (y > 0 && y < project.depth) context.fillText(`${round(y, y % 1 ? 1 : 0)}`, layout.left + 4, a.y - 3);
    }
    context.restore();
  }

  function drawScaleBar() {
    const targetLength = project.width / 5;
    const exponent = 10 ** Math.floor(Math.log10(Math.max(targetLength, 0.001)));
    const normalized = targetLength / exponent;
    const multiple = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
    const length = multiple * exponent;
    const pixels = length * layout.scale;
    const x = layout.left + 12;
    const y = layout.top + layout.planHeight - 14;
    context.strokeStyle = "rgba(13,55,56,0.75)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + pixels, y);
    context.moveTo(x, y - 4);
    context.lineTo(x, y + 4);
    context.moveTo(x + pixels, y - 4);
    context.lineTo(x + pixels, y + 4);
    context.stroke();
    context.fillStyle = "rgba(13,55,56,0.78)";
    context.font = "700 9px Segoe UI, sans-serif";
    context.fillText(`${round(length, length % 1 ? 1 : 0)} m`, x, y - 7);
  }
  function drawMeasurement() {
    if (!measurement?.start || !measurement?.end) return;
    const start = planToCanvas(measurement.start.x, measurement.start.y);
    const end = planToCanvas(measurement.end.x, measurement.end.y);
    const distance = Math.hypot(measurement.end.x - measurement.start.x, measurement.end.y - measurement.start.y);
    if (distance <= 0) return;
    const label = `${round(distance, 2)} m`;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    context.save();
    context.strokeStyle = "#c87928";
    context.fillStyle = "#c87928";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.setLineDash([]);
    [start, end].forEach((point) => {
      context.beginPath();
      context.arc(point.x, point.y, 4, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "white";
      context.lineWidth = 1.5;
      context.stroke();
    });
    context.font = "800 10px Segoe UI, sans-serif";
    const labelWidth = context.measureText(label).width;
    context.fillStyle = "rgba(7,27,28,0.92)";
    context.fillRect(midX - labelWidth / 2 - 6, midY - 22, labelWidth + 12, 18);
    context.fillStyle = "white";
    context.fillText(label, midX - labelWidth / 2, midY - 9);
    context.restore();
  }

  function drawNoiseZones(fill) {
    const zones = Array.isArray(project.noiseZones) ? project.noiseZones : [];
    context.save();
    for (const zone of zones) {
      if (zone.enabled === false) continue;
      const position = planToCanvas(zone.x, zone.y);
      const width = zone.width * layout.scale;
      const height = zone.depth * layout.scale;
      if (fill) {
        context.fillStyle = "rgba(59,112,155,0.09)";
        context.fillRect(position.x, position.y, width, height);
      } else {
        const isSelected = selected && selected.type === "noise" && selected.id === zone.id;
        context.strokeStyle = isSelected ? "#174f7c" : "rgba(40,91,130,0.75)";
        context.lineWidth = isSelected ? 2.5 : 1.2;
        context.setLineDash([5, 4]);
        context.strokeRect(position.x, position.y, width, height);
        context.setLineDash([]);
        if (project.showLabels) drawCanvasLabel(`${zone.name} · ${round(zone.level, 1)} ${decibelUnit()}`, position.x + 5, position.y + 14, "#174f7c");
      }
    }
    context.restore();
  }

  function drawObstacles() {
    const obstacles = Array.isArray(project.obstacles) ? project.obstacles : [];
    context.save();
    for (const obstacle of obstacles) {
      if (obstacle.enabled === false) continue;
      const position = planToCanvas(obstacle.x, obstacle.y);
      const width = obstacle.width * layout.scale;
      const height = obstacle.depth * layout.scale;
      const isSelected = selected && selected.type === "obstacle" && selected.id === obstacle.id;
      context.fillStyle = isSelected ? "rgba(36,53,53,0.7)" : "rgba(36,53,53,0.52)";
      context.fillRect(position.x, position.y, width, height);
      context.strokeStyle = isSelected ? "#0b2526" : "rgba(255,255,255,0.72)";
      context.lineWidth = isSelected ? 2.5 : 1;
      context.strokeRect(position.x, position.y, width, height);
      if (project.showLabels) drawCanvasLabel(`${obstacle.name} · −${round(obstacle.loss, 1)} dB`, position.x + 5, position.y + 14, "#0b2526");
    }
    context.restore();
  }

  function drawBeams() {
    context.save();
    for (const source of project.sources || []) {
      if (source.enabled === false) continue;
      const position = planToCanvas(source.x, source.y);
      const beam = Model.clamp(Number(source.beamWidth), 1, 360);
      const radius = Math.min(layout.planWidth, layout.planHeight) * 0.26;
      context.fillStyle = "rgba(12,83,86,0.075)";
      context.strokeStyle = "rgba(12,83,86,0.27)";
      context.lineWidth = 1;
      if (beam >= 359) {
        context.beginPath();
        context.arc(position.x, position.y, radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      } else {
        const start = Model.degreesToRadians(source.azimuth - beam / 2);
        const end = Model.degreesToRadians(source.azimuth + beam / 2);
        context.beginPath();
        context.moveTo(position.x, position.y);
        context.arc(position.x, position.y, radius, start, end);
        context.closePath();
        context.fill();
        context.stroke();
      }
    }
    context.restore();
  }

  function drawSources() {
    context.save();
    for (const source of project.sources || []) {
      const position = planToCanvas(source.x, source.y);
      const handle = rotationHandlePosition(source);
      const isSelected = selected && selected.type === "source" && selected.id === source.id;
      context.save();
      context.globalAlpha = source.enabled === false ? 0.42 : 1;
      context.strokeStyle = isSelected ? "#0f6669" : "rgba(15,102,105,0.72)";
      context.lineWidth = isSelected ? 2 : 1.4;
      context.beginPath();
      context.moveTo(position.x, position.y);
      context.lineTo(handle.x, handle.y);
      context.stroke();
      context.beginPath();
      context.arc(handle.x, handle.y, isSelected ? 5.5 : 4.5, 0, Math.PI * 2);
      context.fillStyle = isSelected ? "#9ce0c1" : "rgba(255,255,255,0.94)";
      context.fill();
      context.strokeStyle = "#0f6669";
      context.lineWidth = 1.5;
      context.stroke();
      context.restore();
      if (isSelected) {
        context.beginPath();
        context.arc(position.x, position.y, 13, 0, Math.PI * 2);
        context.fillStyle = "rgba(255,255,255,0.88)";
        context.fill();
        context.strokeStyle = "#0f6669";
        context.lineWidth = 2;
        context.stroke();
      }
      context.save();
      context.translate(position.x, position.y);
      context.rotate(Model.degreesToRadians(source.azimuth));
      context.globalAlpha = source.enabled === false ? 0.45 : 1;
      context.fillStyle = source.confidence === "sourced" ? "#0f6669" : "#14575a";
      context.strokeStyle = "white";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(10, 0);
      context.lineTo(2, -6);
      context.lineTo(-7, -6);
      context.lineTo(-7, 6);
      context.lineTo(2, 6);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
      context.beginPath();
      context.arc(position.x, position.y, 2.5, 0, Math.PI * 2);
      context.fillStyle = source.enabled === false ? "#889694" : "#9ce0c1";
      context.fill();
      if (project.showLabels) drawCanvasLabel(source.name, position.x + 10, position.y - 10, "#0b3638");
    }
    context.restore();
  }

  function drawCanvasLabel(text, x, y, color) {
    context.save();
    context.font = "700 9px Segoe UI, sans-serif";
    const width = context.measureText(text).width + 8;
    context.fillStyle = "rgba(255,255,255,0.84)";
    context.fillRect(x - 3, y - 10, width, 14);
    context.fillStyle = color;
    context.fillText(text, x + 1, y);
    context.restore();
  }

  function renderLegend() {
    const target = document.getElementById("mapLegend");
    if (project.viewMode === "compliance") {
      const items = [
        ["#cf5a5e", "Below target"],
        ["#4ba67d", "Compliant"],
      ];
      if (project.enforceMaximum) items.push(["#d58a32", "Over limit"]);
      target.innerHTML = items.map(([color, label]) => `<span class="legend-item"><i class="legend-swatch" style="background:${color}"></i>${label}</span>`).join("");
      return;
    }
    if (project.viewMode === "margin") {
      target.innerHTML = `<div class="gradient-legend"><span>−15 dB</span><i class="gradient-bar" style="background:linear-gradient(90deg,#b84650,#e8d771,#238668)"></i><span>+20 dB</span></div>`;
      return;
    }
    const lower = Math.max(35, Math.min(project.ambientLevel - 10, project.minimumLevel || project.ambientLevel));
    const upper = Math.max(lower + 25, project.maximumLevel || lower + 45, summary.maximum || lower + 45);
    target.innerHTML = `<div class="gradient-legend"><span>${round(lower, 0)}</span><i class="gradient-bar"></i><span>${round(upper, 0)} ${decibelUnit()}</span></div>`;
  }

  function getSelectedObject() {
    if (!selected) return null;
    const collection = selected.type === "source" ? project.sources : selected.type === "noise" ? project.noiseZones : project.obstacles;
    return collection.find((item) => item.id === selected.id) || null;
  }

  function numberField(label, key, value, options = {}) {
    const { min = 0, max = 10000, step = 0.1, unit = "" } = options;
    return `<label class="field"><span>${escapeHtml(label)}${unit ? ` <b>${escapeHtml(unit)}</b>` : ""}</span><input data-object-field="${escapeHtml(key)}" type="number" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}"></label>`;
  }

  function textField(label, key, value, options = {}) {
    return `<label class="field ${options.full ? "full" : ""}"><span>${escapeHtml(label)}</span><input data-object-field="${escapeHtml(key)}" type="text" maxlength="${options.maxlength || 100}" value="${escapeHtml(value)}"></label>`;
  }

  function enabledField(value) {
    return `<label class="check-row"><input data-object-field="enabled" type="checkbox" ${value !== false ? "checked" : ""}><span>Include this object in the study</span></label>`;
  }

  function renderInspector() {
    const object = getSelectedObject();
    const title = document.getElementById("inspectorTitle");
    const type = document.getElementById("selectionType");
    if (!object) {
      selected = null;
      title.textContent = "Study objects";
      type.textContent = "Overview";
      inspector.innerHTML = `<div class="empty-selection"><div class="empty-selection-icon">↖</div><strong>Select an object</strong><p>Click a sound source, noise zone, or obstacle to edit its engineering inputs.</p></div>`;
      scheduleCanvasRender();
      return;
    }

    title.textContent = object.name || "Selected object";
    type.textContent = selected.type === "source" ? "Sound source" : selected.type === "noise" ? "Noise zone" : "Obstacle";
    if (selected.type === "source") renderSourceInspector(object);
    else if (selected.type === "noise") renderNoiseInspector(object);
    else renderObstacleInspector(object);
    scheduleCanvasRender();
  }

  function renderSourceInspector(source) {
    const output = source.referenceSpl + 10 * Math.log10(Math.max(1e-9, source.tapPower) / Math.max(1e-9, source.referencePower));
    const weightingMismatch = source.weighting && source.weighting !== project.weighting;
    const badgeClass = source.confidence === "sourced" ? "sourced" : "";
    inspector.innerHTML = `
      <form class="inspector-form" autocomplete="off">
        ${textField("Tag / name", "name", source.name, { full: true })}
        ${textField("Model", "model", source.model, { full: true })}
        <div class="inspector-summary">
          <div class="summary-cell"><span>Tap output</span><strong>${round(output, 1)} ${escapeHtml(decibelUnit())}</strong></div>
          <div class="summary-cell"><span>Confidence</span><strong>${source.confidence === "sourced" ? "Sourced" : source.confidence === "user" ? "User" : "Verify"}</strong></div>
        </div>
        <div class="field-grid two">
          ${numberField("X", "x", source.x, { min: 0, max: project.width, step: 0.1, unit: "m" })}
          ${numberField("Y", "y", source.y, { min: 0, max: project.depth, step: 0.1, unit: "m" })}
          ${numberField("Height", "z", source.z, { min: 0, max: 1000, step: 0.1, unit: "m" })}
          ${numberField("Azimuth", "azimuth", source.azimuth, { min: 0, max: 360, step: 1, unit: "°" })}
        </div>
        <div class="section-kicker">Reference condition</div>
        <div class="field-grid two">
          ${numberField("Reference SPL", "referenceSpl", source.referenceSpl, { min: 0, max: 180, step: 0.1, unit: `dB${source.weighting || ""}` })}
          ${numberField("Reference distance", "referenceDistance", source.referenceDistance, { min: 0.1, max: 10000, step: 0.1, unit: "m" })}
          ${numberField("Reference power", "referencePower", source.referencePower, { min: 0.001, max: 100000, step: 0.1, unit: "W" })}
          ${numberField("Tap / operating power", "tapPower", source.tapPower, { min: 0.001, max: 100000, step: 0.1, unit: "W" })}
          ${numberField("Rated power", "ratedPower", source.ratedPower, { min: 0.001, max: 100000, step: 0.1, unit: "W" })}
          ${numberField("Near-field clamp", "nearFieldDistance", source.nearFieldDistance, { min: 0.1, max: 10000, step: 0.1, unit: "m" })}
        </div>
        <div class="section-kicker">Direction & losses</div>
        <div class="field-grid two">
          ${numberField("Beam width", "beamWidth", source.beamWidth, { min: 1, max: 360, step: 1, unit: "°" })}
          ${numberField("Rear attenuation", "rearAttenuation", source.rearAttenuation, { min: 0, max: 100, step: 0.5, unit: "dB" })}
          ${numberField("Additional loss", "additionalLoss", source.additionalLoss, { min: 0, max: 100, step: 0.5, unit: "dB" })}
          ${textField("Speaker loop", "loop", source.loop)}
        </div>
        ${enabledField(source.enabled)}
        <div class="provenance-note ${badgeClass}">${weightingMismatch ? `<b>Weighting mismatch:</b> source is dB${escapeHtml(source.weighting)}, study is ${escapeHtml(decibelUnit())}. ` : ""}${escapeHtml(source.provenance || "No provenance note supplied.")}</div>
        <div class="inspector-actions">
          <button class="button" type="button" data-object-action="duplicate">Duplicate</button>
          <button class="button danger" type="button" data-object-action="delete">Delete</button>
        </div>
      </form>`;
  }

  function renderNoiseInspector(zone) {
    inspector.innerHTML = `
      <form class="inspector-form" autocomplete="off">
        ${textField("Zone name", "name", zone.name, { full: true })}
        <div class="field-grid two">
          ${numberField("X", "x", zone.x, { min: 0, max: project.width, step: 0.1, unit: "m" })}
          ${numberField("Y", "y", zone.y, { min: 0, max: project.depth, step: 0.1, unit: "m" })}
          ${numberField("Width", "width", zone.width, { min: 0.1, max: project.width, step: 0.1, unit: "m" })}
          ${numberField("Depth", "depth", zone.depth, { min: 0.1, max: project.depth, step: 0.1, unit: "m" })}
          ${numberField("Ambient level", "level", zone.level, { min: 0, max: 180, step: 0.5, unit: decibelUnit() })}
        </div>
        <div class="provenance-note sourced">Zones override the project ambient level inside their rectangle. When zones overlap, the last zone in the project schedule controls.</div>
        ${enabledField(zone.enabled)}
        <div class="inspector-actions">
          <button class="button" type="button" data-object-action="duplicate">Duplicate</button>
          <button class="button danger" type="button" data-object-action="delete">Delete</button>
        </div>
      </form>`;
  }

  function renderObstacleInspector(obstacle) {
    inspector.innerHTML = `
      <form class="inspector-form" autocomplete="off">
        ${textField("Obstacle name", "name", obstacle.name, { full: true })}
        <div class="field-grid two">
          ${numberField("X", "x", obstacle.x, { min: 0, max: project.width, step: 0.1, unit: "m" })}
          ${numberField("Y", "y", obstacle.y, { min: 0, max: project.depth, step: 0.1, unit: "m" })}
          ${numberField("Width", "width", obstacle.width, { min: 0.1, max: project.width, step: 0.1, unit: "m" })}
          ${numberField("Depth", "depth", obstacle.depth, { min: 0.1, max: project.depth, step: 0.1, unit: "m" })}
          ${numberField("Height", "height", obstacle.height, { min: 0, max: 1000, step: 0.1, unit: "m" })}
          ${numberField("Insertion loss", "loss", obstacle.loss, { min: 0, max: 100, step: 0.5, unit: "dB" })}
        </div>
        <div class="provenance-note">A rectangular line-of-sight screening loss is applied when the source-to-receiver ray intersects the obstacle below its height. This is not diffraction or reflection modeling.</div>
        ${enabledField(obstacle.enabled)}
        <div class="inspector-actions">
          <button class="button" type="button" data-object-action="duplicate">Duplicate</button>
          <button class="button danger" type="button" data-object-action="delete">Delete</button>
        </div>
      </form>`;
  }

  function renderObjectList() {
    const groups = [
      ["Sources", "source", project.sources || []],
      ["Noise zones", "noise", project.noiseZones || []],
      ["Obstacles", "obstacle", project.obstacles || []],
    ];
    const count = groups.reduce((total, group) => total + group[2].length, 0);
    document.getElementById("objectCount").textContent = String(count);
    if (!count) {
      objectList.innerHTML = `<p class="microcopy">No study objects yet. Add a source, noise zone, or obstacle from the map toolbar.</p>`;
      return;
    }
    objectList.innerHTML = groups
      .filter((group) => group[2].length)
      .map(([label, type, items]) => `
        <div class="object-group-label">${label} · ${items.length}</div>
        ${items.map((item) => {
          const active = selected && selected.type === type && selected.id === item.id;
          const detail = type === "source"
            ? `${round(item.tapPower, item.tapPower % 1 ? 1 : 0)} W · ${escapeHtml(item.loop || "Unassigned")}`
            : type === "noise"
              ? `${round(item.level, 1)} ${escapeHtml(decibelUnit())}`
              : `${round(item.height, 1)} m · −${round(item.loss, 1)} dB`;
          return `<button class="object-row ${active ? "selected" : ""}" type="button" data-object-type="${type}" data-object-id="${escapeHtml(item.id)}"><span class="object-icon">${type === "source" ? "⌁" : type === "noise" ? "N" : "▰"}</span><span class="object-name"><b>${escapeHtml(item.name)}</b><small>${detail}</small></span><i class="object-status ${item.enabled === false ? "off" : ""}"></i></button>`;
        }).join("")}`)
      .join("");
  }

  function setPlacementMode(mode) {
    placementMode = placementMode === mode ? null : mode;
    if (mode && measurementMode) setMeasurementMode(false, { clear: false });
    document.getElementById("placeSourceButton").classList.toggle("placing", placementMode === "source");
    document.getElementById("addNoiseZoneButton").classList.toggle("placing", placementMode === "noise");
    document.getElementById("addObstacleButton").classList.toggle("placing", placementMode === "obstacle");
    canvas.classList.toggle("placing", Boolean(placementMode));
    canvas.style.cursor = "";
    const label = placementMode === "source" ? "Click the plan to place a sound source" : placementMode === "noise" ? "Click the plan to add a noise zone" : placementMode === "obstacle" ? "Click the plan to add an obstacle" : "Drag symbol to move · drag its round handle to rotate · hold Shift to snap 15°";
    document.getElementById("mapHint").textContent = label;
  }

  function addAtPoint(type, point) {
    if (type === "source") {
      const key = document.getElementById("devicePresetSelect").value;
      const source = Model.instantiateDevice(key, {
        name: `SRC-${String(project.sources.length + 1).padStart(2, "0")}`,
        x: point.x,
        y: point.y,
        loop: `L${Math.max(1, Math.ceil((project.sources.length + 1) / 8))}`,
      });
      project.sources.push(source);
      selected = { type: "source", id: source.id };
      showToast(`${source.name} placed.`);
    } else if (type === "noise") {
      const width = Math.min(project.width * 0.25, 30);
      const depth = Math.min(project.depth * 0.25, 20);
      const zone = {
        id: Model.makeId("noise"),
        name: `Noise zone ${project.noiseZones.length + 1}`,
        x: Model.clamp(point.x - width / 2, 0, project.width - width),
        y: Model.clamp(point.y - depth / 2, 0, project.depth - depth),
        width,
        depth,
        level: project.ambientLevel + 5,
        enabled: true,
      };
      project.noiseZones.push(zone);
      selected = { type: "noise", id: zone.id };
      showToast("Noise zone added. Edit its size and ambient level in the inspector.");
    } else {
      const width = Math.min(project.width * 0.2, 24);
      const depth = Math.min(project.depth * 0.15, 14);
      const obstacle = {
        id: Model.makeId("obstacle"),
        name: `Obstacle ${project.obstacles.length + 1}`,
        x: Model.clamp(point.x - width / 2, 0, project.width - width),
        y: Model.clamp(point.y - depth / 2, 0, project.depth - depth),
        width,
        depth,
        height: 6,
        loss: 10,
        enabled: true,
      };
      project.obstacles.push(obstacle);
      selected = { type: "obstacle", id: obstacle.id };
      showToast("Obstacle added. Set a verified insertion loss before issue.");
    }
    setPlacementMode(null);
    markChanged();
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(canvasPoint) {
    for (let index = project.sources.length - 1; index >= 0; index -= 1) {
      const source = project.sources[index];
      const handle = rotationHandlePosition(source);
      if (Math.hypot(canvasPoint.x - handle.x, canvasPoint.y - handle.y) <= ROTATION_HANDLE_HIT_RADIUS) return { type: "source", id: source.id, object: source, part: "rotation" };
    }
    for (let index = project.sources.length - 1; index >= 0; index -= 1) {
      const source = project.sources[index];
      const position = planToCanvas(source.x, source.y);
      if (Math.hypot(canvasPoint.x - position.x, canvasPoint.y - position.y) <= 13) return { type: "source", id: source.id, object: source };
    }
    const planPoint = canvasToPlan(canvasPoint.x, canvasPoint.y);
    for (let index = project.obstacles.length - 1; index >= 0; index -= 1) {
      const item = project.obstacles[index];
      if (planPoint.x >= item.x && planPoint.x <= item.x + item.width && planPoint.y >= item.y && planPoint.y <= item.y + item.depth) return { type: "obstacle", id: item.id, object: item };
    }
    for (let index = project.noiseZones.length - 1; index >= 0; index -= 1) {
      const item = project.noiseZones[index];
      if (planPoint.x >= item.x && planPoint.x <= item.x + item.width && planPoint.y >= item.y && planPoint.y <= item.y + item.depth) return { type: "noise", id: item.id, object: item };
    }
    return null;
  }

  function startDrag(hit, planPoint) {
    if (!hit) return;
    const object = hit.object;
    dragging = {
      type: hit.type,
      id: hit.id,
      action: hit.part === "rotation" ? "rotate" : "move",
      offsetX: planPoint.x - object.x,
      offsetY: planPoint.y - object.y,
    };
    canvas.style.cursor = "";
    canvas.classList.add(hit.part === "rotation" ? "rotating" : "dragging");
  }

  function moveDraggedObject(planPoint, event) {
    if (!dragging) return;
    const object = getSelectedObject();
    if (!object) return;
    if (dragging.action === "rotate") {
      let angle = (Math.atan2(planPoint.y - object.y, planPoint.x - object.x) * 180) / Math.PI;
      if (event && event.shiftKey) angle = Math.round(angle / 15) * 15;
      object.azimuth = Model.normalizeAngle(angle);
      project.updatedAt = new Date().toISOString();
      recalculate();
      return;
    }
    const objectWidth = dragging.type === "source" ? 0 : object.width;
    const objectDepth = dragging.type === "source" ? 0 : object.depth;
    object.x = Model.clamp(planPoint.x - dragging.offsetX, 0, Math.max(0, project.width - objectWidth));
    object.y = Model.clamp(planPoint.y - dragging.offsetY, 0, Math.max(0, project.depth - objectDepth));
    project.updatedAt = new Date().toISOString();
    recalculate();
  }

  function showMapTooltip(event, canvasPoint) {
    if (placementMode || dragging) {
      mapTooltip.hidden = true;
      return;
    }
    const inside = canvasPoint.x >= layout.left && canvasPoint.y >= layout.top && canvasPoint.x <= layout.left + layout.planWidth && canvasPoint.y <= layout.top + layout.planHeight;
    if (!inside) {
      mapTooltip.hidden = true;
      return;
    }
    const point = canvasToPlan(canvasPoint.x, canvasPoint.y);
    const result = Model.calculatePoint(project, point.x, point.y);
    const unit = decibelUnit();
    mapTooltip.innerHTML = `<b><span>${round(point.x, 1)}, ${round(point.y, 1)} m</span><em>${Number.isFinite(result.level) ? `${round(result.level, 1)} ${unit}` : "No source"}</em></b><span>Ambient <em>${round(result.ambient, 1)} ${unit}</em></span><span>Target <em>${round(result.target, 1)} ${unit}</em></span><span>Margin <em>${Number.isFinite(result.margin) ? `${result.margin >= 0 ? "+" : ""}${round(result.margin, 1)} dB` : "—"}</em></span><span>Status <em>${escapeHtml(result.status)}</em></span>`;
    mapTooltip.hidden = false;
    const cardRect = canvasCard.getBoundingClientRect();
    const tooltipWidth = 172;
    const left = Math.min(event.clientX - cardRect.left + 14, cardRect.width - tooltipWidth - 10);
    const top = Math.min(event.clientY - cardRect.top + 14, cardRect.height - 112);
    mapTooltip.style.left = `${Math.max(8, left)}px`;
    mapTooltip.style.top = `${Math.max(8, top)}px`;
  }

  function deleteSelected() {
    if (!selected) return;
    const key = selected.type === "source" ? "sources" : selected.type === "noise" ? "noiseZones" : "obstacles";
    const object = getSelectedObject();
    project[key] = project[key].filter((item) => item.id !== selected.id);
    selected = null;
    markChanged();
    showToast(`${object ? object.name : "Object"} removed.`);
  }

  function duplicateSelected() {
    const object = getSelectedObject();
    if (!object || !selected) return;
    const key = selected.type === "source" ? "sources" : selected.type === "noise" ? "noiseZones" : "obstacles";
    const duplicate = {
      ...object,
      id: Model.makeId(selected.type),
      name: `${object.name} copy`,
      x: Model.clamp(object.x + project.width * 0.03, 0, project.width - (object.width || 0)),
      y: Model.clamp(object.y + project.depth * 0.03, 0, project.depth - (object.depth || 0)),
    };
    project[key].push(duplicate);
    selected = { type: selected.type, id: duplicate.id };
    markChanged();
    showToast(`${duplicate.name} created.`);
  }

  function updateSelectedField(control) {
    const object = getSelectedObject();
    if (!object) return;
    const key = control.dataset.objectField;
    if (control.type === "checkbox") object[key] = control.checked;
    else if (control.type === "number" || control.type === "range") object[key] = Number(control.value);
    else object[key] = control.value;
    if (selected.type === "source") {
      object.x = Model.clamp(Number(object.x), 0, project.width);
      object.y = Model.clamp(Number(object.y), 0, project.depth);
      object.azimuth = Model.normalizeAngle(object.azimuth);
      object.tapPower = Math.min(Math.max(0.001, Number(object.tapPower)), Math.max(0.001, Number(object.ratedPower) || object.tapPower));
    } else {
      object.width = Model.clamp(Number(object.width), 0.1, project.width);
      object.depth = Model.clamp(Number(object.depth), 0.1, project.depth);
      object.x = Model.clamp(Number(object.x), 0, project.width - object.width);
      object.y = Model.clamp(Number(object.y), 0, project.depth - object.depth);
    }
    markChanged({ refreshInspector: control.type === "checkbox" });
    document.getElementById("inspectorTitle").textContent = object.name || "Selected object";
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(value, extension) {
    const base = String(value || "sound-coverage-study")
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "sound-coverage-study";
    return `${base}.${extension}`;
  }

  function exportProject() {
    downloadFile(safeFilename(project.title, "json"), JSON.stringify(project, null, 2), "application/json");
    showToast("Project JSON exported.");
  }

  function exportCsv() {
    const header = ["x_m", "y_m", `spl_db${project.weighting.toLowerCase()}`, `ambient_db${project.weighting.toLowerCase()}`, "target_db", "margin_db", "status"];
    const rows = grid.points.map((point) => [
      point.x.toFixed(3),
      point.y.toFixed(3),
      Number.isFinite(point.level) ? point.level.toFixed(3) : "",
      point.ambient.toFixed(3),
      point.target.toFixed(3),
      Number.isFinite(point.margin) ? point.margin.toFixed(3) : "",
      point.status,
    ]);
    downloadFile(safeFilename(`${project.title}-grid`, "csv"), [header, ...rows].map((row) => row.join(",")).join("\r\n"), "text/csv;charset=utf-8");
    showToast(`${rows.length.toLocaleString()} receiver samples exported.`);
  }

  function importProjectFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = Model.sanitizeProject(JSON.parse(String(reader.result)));
        project = imported;
        selected = null;
        setPlacementMode(null);
        syncProjectControls();
        recalculate();
        renderObjectList();
        renderInspector();
        debounceSave();
        showToast("Project imported successfully.");
      } catch (error) {
        console.error(error);
        showToast("That file is not a valid Sound Coverage Study project.");
      }
    };
    reader.readAsText(file);
  }

  function updatePrintReport() {
    const report = document.getElementById("printReport");
    const unit = decibelUnit();
    const criteria = Model.MODE_CRITERIA[project.mode] || Model.MODE_CRITERIA.paging;
    const loops = Model.summarizeLoops(project);
    const image = canvas.toDataURL("image/png");
    const sourceRows = project.sources.map((source) => `<tr><td>${escapeHtml(source.name)}</td><td>${escapeHtml(source.model)}</td><td>${round(source.x, 1)}, ${round(source.y, 1)}</td><td>${round(source.z, 1)}</td><td>${round(source.azimuth, 0)}° / ${round(source.beamWidth, 0)}°</td><td>${round(source.tapPower, 1)} W</td><td>${escapeHtml(source.loop || "—")}</td><td>${source.confidence === "sourced" ? "Sourced" : "Verify"}</td></tr>`).join("");
    const loopRows = loops.map((loop) => `<tr><td>${escapeHtml(loop.name)}</td><td>${loop.count}</td><td>${round(loop.connectedLoad, 1)} W</td><td>${round(loop.withHeadroom, 1)} W</td></tr>`).join("");
    const zoneRows = project.noiseZones.map((zone) => `<tr><td>${escapeHtml(zone.name)}</td><td>${round(zone.x, 1)}, ${round(zone.y, 1)}</td><td>${round(zone.width, 1)} × ${round(zone.depth, 1)} m</td><td>${round(zone.level, 1)} ${unit}</td></tr>`).join("");
    report.innerHTML = `
      <div class="print-cover">
        <div><div class="section-kicker">PAGA engineering workspace</div><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(criteria.label)} · Receiver plane ${round(project.receiverHeight, 1)} m · Revision ${escapeHtml(project.revision || "—")}</p></div>
        <dl class="print-meta"><dt>Prepared by</dt><dd>${escapeHtml(project.preparedBy || "—")}</dd><dt>Generated</dt><dd>${new Date().toLocaleString()}</dd><dt>Study size</dt><dd>${round(project.width, 1)} × ${round(project.depth, 1)} m</dd><dt>Weighting</dt><dd>${escapeHtml(unit)}</dd></dl>
      </div>
      <div class="print-summary">
        <div><span>Compliant area</span><strong>${round(summary.compliantPercent, 1)}%</strong></div>
        <div><span>Meets minimum</span><strong>${round(summary.audiblePercent, 1)}%</strong></div>
        <div><span>Average SPL</span><strong>${round(summary.arithmeticAverage, 1)} ${unit}</strong></div>
        <div><span>Range</span><strong>${round(summary.minimum, 1)}–${round(summary.maximum, 1)}</strong></div>
        <div><span>Connected load</span><strong>${round(summary.connectedLoad, 1)} W</strong></div>
        <div><span>Sources</span><strong>${summary.sourceCount}</strong></div>
      </div>
      <img class="print-map" src="${image}" alt="Sound coverage map">
      <div class="print-grid">
        <section><h2>Acceptance & model basis</h2><table><tbody><tr><th>Criterion</th><th>Value</th></tr><tr><td>Ambient / required margin</td><td>${round(project.ambientLevel, 1)} ${unit} / +${round(project.requiredMargin, 1)} dB</td></tr><tr><td>Absolute minimum</td><td>${round(project.minimumLevel, 1)} ${unit}</td></tr><tr><td>Maximum assessment</td><td>${round(project.maximumLevel, 1)} ${unit} (${project.enforceMaximum ? "enforced" : "reference only"})</td></tr><tr><td>Other / air loss</td><td>${round(project.fixedLoss, 1)} dB / ${round(project.airLossPer100m, 2)} dB per 100 m</td></tr><tr><td>Sampling</td><td>${grid.points.length.toLocaleString()} points at ${round(grid.spacing, 2)} m spacing</td></tr></tbody></table><h3>Engineering notes</h3><div class="print-note">${escapeHtml(project.notes || "No project notes entered.")}</div></section>
        <section><h2>Amplifier loop summary</h2><table><thead><tr><th>Loop</th><th>Qty</th><th>Load</th><th>With ${round(project.amplifierHeadroom, 0)}% spare</th></tr></thead><tbody>${loopRows || `<tr><td colspan="4">No active sources</td></tr>`}</tbody></table>${zoneRows ? `<h3>Noise zones</h3><table><thead><tr><th>Zone</th><th>Origin</th><th>Size</th><th>Ambient</th></tr></thead><tbody>${zoneRows}</tbody></table>` : ""}</section>
      </div>
      <section class="page-break-before"><h2>Sound source schedule</h2><table><thead><tr><th>Tag</th><th>Model</th><th>X, Y (m)</th><th>Z (m)</th><th>Az. / beam</th><th>Tap</th><th>Loop</th><th>Data</th></tr></thead><tbody>${sourceRows || `<tr><td colspan="8">No sources</td></tr>`}</tbody></table><h3>Model boundary & sources</h3><p class="print-note">Screening calculation: editable reference SPL plus 10 log power adjustment, 20 log distance divergence, approximate horizontal directivity, fixed/air losses, rectangular obstacle insertion loss, and energetic source summation. Not a substitute for approved octave-band ray tracing, manufacturer polar data, intelligibility analysis, or field verification.</p><ul class="print-sources"><li>CE-040449-001 - In-Plant Paging Sound Coverage Study</li><li>CE-040450-001 - Emergency Siren Sound Coverage Study</li><li>CE-040451-001 - Public Address Sound Coverage Study</li><li>Maintenance Building_PAGA.pdf; Substation PAGA.pdf; Block Diagram PAGA.pdf</li><li>Acoustic Study.pdf is retained in the repository but did not expose a parseable PDF structure.</li></ul></section>`;
  }

  function bindEvents() {
    document.querySelectorAll("[data-project-field]").forEach((control) => {
      const eventName = control.type === "range" ? "input" : "change";
      control.addEventListener(eventName, () => {
        const key = control.dataset.projectField;
        if (control.type === "checkbox") project[key] = control.checked;
        else if (control.type === "number" || control.type === "range") project[key] = Number(control.value);
        else project[key] = control.value;
        if (["width", "depth"].includes(key)) {
          project.sources.forEach((source) => {
            source.x = Model.clamp(source.x, 0, project.width);
            source.y = Model.clamp(source.y, 0, project.depth);
          });
        }
        markChanged({ refreshInspector: false });
      });
      if (["title", "revision", "preparedBy", "notes"].includes(control.dataset.projectField)) {
        control.addEventListener("input", () => {
          project[control.dataset.projectField] = control.value;
          project.updatedAt = new Date().toISOString();
          debounceSave();
        });
      }
    });

    document.querySelectorAll(".mode-option").forEach((button) => {
      button.addEventListener("click", () => {
        project = Model.applyModeCriteria(project, button.dataset.mode);
        document.getElementById("devicePresetSelect").value = project.mode === "siren" ? "siren3200" : "horn25";
        syncProjectControls();
        markChanged({ refreshInspector: false });
        showToast("System criteria updated. Existing source devices were preserved.");
      });
    });

    document.getElementById("viewModeSelect").addEventListener("change", (event) => {
      project.viewMode = event.target.value;
      markChanged({ refreshInspector: false });
    });
    document.getElementById("gridToggle").addEventListener("click", () => toggleProjectFlag("showGrid", "gridToggle"));
    document.getElementById("beamToggle").addEventListener("click", () => toggleProjectFlag("showBeams", "beamToggle"));
    document.getElementById("labelToggle").addEventListener("click", () => toggleProjectFlag("showLabels", "labelToggle"));
    document.getElementById("fitButton").addEventListener("click", () => {
      scheduleCanvasRender();
      showToast("Plan fitted to the available workspace.");
    });

    document.getElementById("placeSourceButton").addEventListener("click", () => setPlacementMode("source"));
    document.getElementById("addNoiseZoneButton").addEventListener("click", () => setPlacementMode("noise"));
    document.getElementById("addObstacleButton").addEventListener("click", () => setPlacementMode("obstacle"));

    document.getElementById("applyCalibrationButton").addEventListener("click", applyDrawingScale);
    document.getElementById("measureButton").addEventListener("click", () => setMeasurementMode(!measurementMode));
    ["backgroundScaleDenominator", "backgroundDpi"].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => {
        const scaleDenominator = Number(document.getElementById("backgroundScaleDenominator").value);
        const dpi = Number(document.getElementById("backgroundDpi").value);
        const metrics = calibrationMetrics(scaleDenominator, dpi);
        document.getElementById("calibrationSummary").innerHTML = Number.isFinite(metrics.pixelsPerMetre) && metrics.pixelWidth
          ? `Preview <b>1:${round(scaleDenominator, 0)}</b> ; 1 m = <b>${round(metrics.pixelsPerMetre, 2)} px</b> ; <b>${round(metrics.width, 2)} x ${round(metrics.depth, 2)} m</b>. Click Apply scale to use it.`
          : "Enter a valid drawing scale and DPI.";
      });
    });
    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      const position = pointerPosition(event);
      const planPoint = canvasToPlan(position.x, position.y);
      if (measurementMode) {
        if (!measurement?.start || measurement.complete) {
          measurement = { start: planPoint, end: planPoint, complete: false };
          document.getElementById("mapHint").textContent = "Measure: click the second point";
        } else {
          measurement.end = planPoint;
          measurement.complete = true;
          setMeasurementMode(false, { clear: false });
          updateMeasurementReadout();
        }
        scheduleCanvasRender();
        return;
      }
      if (placementMode) {
        addAtPoint(placementMode, planPoint);
        return;
      }
      const hit = hitTest(position);
      selected = hit ? { type: hit.type, id: hit.id } : null;
      renderObjectList();
      renderInspector();
      if (hit) startDrag(hit, planPoint);
      else scheduleCanvasRender();
    });
    canvas.addEventListener("pointermove", (event) => {
      const position = pointerPosition(event);
      if (dragging) moveDraggedObject(canvasToPlan(position.x, position.y), event);
      if (dragging) return;
      if (measurementMode) {
        canvas.style.cursor = "crosshair";
        mapTooltip.hidden = true;
        if (measurement?.start && !measurement.complete) {
          measurement.end = canvasToPlan(position.x, position.y);
          updateMeasurementReadout();
          scheduleCanvasRender();
        }
        return;
      }
      else {
        const hit = placementMode ? null : hitTest(position);
        canvas.style.cursor = hit && hit.part === "rotation" ? "grab" : hit ? "move" : "";
        showMapTooltip(event, position);
      }
    });
    canvas.addEventListener("pointerup", () => {
      if (dragging) {
        dragging = null;
        canvas.classList.remove("dragging");
        canvas.classList.remove("rotating");
        renderInspector();
        renderObjectList();
        debounceSave();
      }
    });
    canvas.addEventListener("pointercancel", () => {
      dragging = null;
      canvas.classList.remove("dragging");
      canvas.classList.remove("rotating");
    });
    canvas.addEventListener("pointerleave", () => {
      if (!dragging) mapTooltip.hidden = true;
    });

    inspector.addEventListener("change", (event) => {
      if (event.target.matches("[data-object-field]")) updateSelectedField(event.target);
    });
    inspector.addEventListener("input", (event) => {
      if (event.target.matches('[data-object-field][type="range"]')) updateSelectedField(event.target);
    });
    inspector.addEventListener("click", (event) => {
      const button = event.target.closest("[data-object-action]");
      if (!button) return;
      if (button.dataset.objectAction === "delete") deleteSelected();
      if (button.dataset.objectAction === "duplicate") duplicateSelected();
    });
    objectList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-object-id]");
      if (!button) return;
      selected = { type: button.dataset.objectType, id: button.dataset.objectId };
      renderObjectList();
      renderInspector();
    });

    document.addEventListener("keydown", (event) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
      if (event.key === "Escape") {
        setPlacementMode(null);
        mapTooltip.hidden = true;
        setMeasurementMode(false, { clear: true });
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected && !editing) {
        event.preventDefault();
        deleteSelected();
      }
    });

    document.getElementById("backgroundInput").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        showToast("Choose a plan image smaller than 8 MB for reliable offline autosave.");
        event.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        project.backgroundImage = String(reader.result);
        project.backgroundName = file.name;
        project.backgroundOpacity = 0.35;
        syncProjectControls();
        markChanged({ refreshInspector: false });
        showToast("Plan background loaded. Set study dimensions to calibrate its scale.");
      };
      reader.readAsDataURL(file);
    });
    document.getElementById("removeBackgroundButton").addEventListener("click", () => {
      project.backgroundImage = "";
      project.backgroundName = "";
      syncProjectControls();
      project.backgroundPixelWidth = 0;
      project.backgroundPixelHeight = 0;
      setMeasurementMode(false, { clear: true });
      updatePlanCalibrationUI();
      markChanged({ refreshInspector: false });
      showToast("Plan background removed.");
    });

    document.getElementById("newProjectButton").addEventListener("click", () => confirmDialog.showModal());
    document.getElementById("confirmNewButton").addEventListener("click", () => {
      project = Model.createProject(project.mode);
      selected = null;
      setPlacementMode(null);
      confirmDialog.close();
      setMeasurementMode(false, { clear: true });
      syncProjectControls();
      recalculate();
      renderObjectList();
      renderInspector();
      debounceSave();
      showToast("New example study created.");
    });
    document.getElementById("importButton").addEventListener("click", () => document.getElementById("projectFileInput").click());
    document.getElementById("projectFileInput").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importProjectFile(file);
      event.target.value = "";
    });
    document.getElementById("exportButton").addEventListener("click", exportProject);
    document.getElementById("csvButton").addEventListener("click", exportCsv);
    document.getElementById("printButton").addEventListener("click", () => {
      updatePrintReport();
      window.setTimeout(() => window.print(), 60);
    });
    document.getElementById("referencesButton").addEventListener("click", () => referencesDialog.showModal());
    document.getElementById("criteriaInfoButton").addEventListener("click", () => referencesDialog.showModal());
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog").close());
    });
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
    });

    const observer = new ResizeObserver(() => scheduleCanvasRender());
    observer.observe(canvasCard);
  }

  function toggleProjectFlag(key, buttonId) {
    project[key] = !project[key];
    syncToggle(buttonId, project[key]);
    markChanged({ refreshInspector: false });
  }

  function start() {
    populateDevicePresets();
    syncProjectControls();
    bindEvents();
    recalculate();
    renderObjectList();
    renderInspector();
  }

  start();
})();
