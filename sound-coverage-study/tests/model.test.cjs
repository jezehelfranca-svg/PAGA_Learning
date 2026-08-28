const assert = require("node:assert/strict");
const test = require("node:test");
const Model = require("../src/model.js");

function simpleProject() {
  return {
    ...Model.createProject("paging"),
    width: 20,
    depth: 20,
    receiverHeight: 1,
    fixedLoss: 0,
    airLossPer100m: 0,
    noiseZones: [],
    obstacles: [],
    sources: [],
  };
}

function source(overrides = {}) {
  return Model.instantiateDevice("custom", {
    x: 0,
    y: 0,
    z: 1,
    referenceSpl: 100,
    referenceDistance: 1,
    referencePower: 1,
    tapPower: 1,
    beamWidth: 360,
    rearAttenuation: 0,
    nearFieldDistance: 0.1,
    additionalLoss: 0,
    ...overrides,
  });
}

test("doubling source power adds approximately 3.01 dB", () => {
  const project = simpleProject();
  const base = Model.sourceLevelAtPoint(project, source({ tapPower: 1 }), 10, 0);
  const doubled = Model.sourceLevelAtPoint(project, source({ tapPower: 2 }), 10, 0);
  assert.ok(Math.abs(doubled - base - 3.0103) < 0.001);
});

test("doubling distance subtracts approximately 6.02 dB", () => {
  const project = simpleProject();
  const item = source();
  const near = Model.sourceLevelAtPoint(project, item, 5, 0);
  const far = Model.sourceLevelAtPoint(project, item, 10, 0);
  assert.ok(Math.abs(near - far - 6.0206) < 0.001);
});

test("two equal incoherent sources add approximately 3.01 dB", () => {
  const combined = Model.energeticSum([80, 80]);
  assert.ok(Math.abs(combined - 83.0103) < 0.001);
});

test("ambient zones override the project background and set the margin target", () => {
  const project = simpleProject();
  project.ambientLevel = 55;
  project.minimumLevel = 80;
  project.requiredMargin = 10;
  project.noiseZones = [{ x: 4, y: 4, width: 4, depth: 4, level: 75, enabled: true }];
  assert.equal(Model.noiseAtPoint(project, 2, 2), 55);
  assert.equal(Model.noiseAtPoint(project, 5, 5), 75);
  assert.equal(Model.targetForNoise(project, 55), 80);
  assert.equal(Model.targetForNoise(project, 75), 85);
});

test("a lower zone ambient replaces the higher project ambient", () => {
  const project = simpleProject();
  project.ambientLevel = 75;
  project.minimumLevel = 0;
  project.requiredMargin = 10;
  project.noiseZones = [{ x: 4, y: 4, width: 4, depth: 4, level: 55, minimumLevel: 0, enabled: true }];
  assert.equal(Model.noiseAtPoint(project, 2, 2), 75);
  assert.equal(Model.calculatePoint(project, 2, 2).target, 85);
  assert.equal(Model.noiseAtPoint(project, 5, 5), 55);
  assert.equal(Model.calculatePoint(project, 5, 5).target, 65);
});

test("noise zones can override compliance margin and minimum target", () => {
  const project = simpleProject();
  project.ambientLevel = 50;
  project.minimumLevel = 60;
  project.requiredMargin = 10;
  project.noiseZones = [
    { x: 0, y: 0, width: 5, depth: 5, level: 70, requiredMargin: 5, enabled: true },
    { x: 5, y: 0, width: 5, depth: 5, level: 80, requiredMargin: 15, minimumLevel: 100, enabled: true },
  ];

  assert.equal(Model.targetForNoiseZone(project, project.noiseZones[0]), 75);
  assert.equal(Model.calculatePoint(project, 2, 2).target, 75);
  assert.equal(Model.calculatePoint(project, 7, 2).target, 100);
});

test("overlapping noise zones use the most demanding active target", () => {
  const project = simpleProject();
  project.ambientLevel = 50;
  project.minimumLevel = 60;
  project.requiredMargin = 10;
  project.noiseZones = [
    { x: 0, y: 0, width: 8, depth: 8, level: 70, requiredMargin: 5, enabled: true },
    { x: 2, y: 2, width: 8, depth: 8, level: 65, requiredMargin: 40, enabled: true },
  ];

  const requirement = Model.noiseRequirementAtPoint(project, 4, 4);
  assert.equal(requirement.ambient, 70);
  assert.equal(requirement.target, 105);
});

test("a line-of-sight obstacle applies its insertion loss", () => {
  const project = simpleProject();
  const item = source({ x: 0, y: 10, z: 2 });
  project.obstacles = [{ x: 4, y: 8, width: 2, depth: 4, height: 6, loss: 12, enabled: true }];
  const clear = { ...project, obstacles: [] };
  const clearLevel = Model.sourceLevelAtPoint(clear, item, 10, 10);
  const screenedLevel = Model.sourceLevelAtPoint(project, item, 10, 10);
  assert.ok(Math.abs(clearLevel - screenedLevel - 12) < 0.001);
});

test("the sourced siren profile returns 118 dBC at its 30 m reference", () => {
  const project = simpleProject();
  project.receiverHeight = 15;
  const siren = Model.instantiateDevice("siren3200", { x: 0, y: 0, z: 15 });
  const result = Model.sourceLevelAtPoint(project, siren, 30, 0);
  assert.ok(Math.abs(result - 118) < 0.001);
});

test("outdoor loudspeaker requirements evaluate rated output at one meter", () => {
  const weatherproof = source({
    referenceSpl: 105,
    referenceDistance: 1,
    referencePower: 1,
    ratedPower: 80,
    weighting: "A",
    outputRequirement: "outdoorWeatherproof",
  });
  const weatherproofResult = Model.evaluateSourceOutputRequirement(weatherproof);
  assert.ok(Math.abs(weatherproofResult.ratedOutput - 124.0309) < 0.001);
  assert.equal(weatherproofResult.minimumLevel, 124);
  assert.equal(weatherproofResult.compliant, true);

  const flameproof = source({
    referenceSpl: 105,
    referenceDistance: 1,
    referencePower: 1,
    ratedPower: 20,
    weighting: "A",
    outputRequirement: "outdoorFlameproof",
  });
  const flameproofResult = Model.evaluateSourceOutputRequirement(flameproof);
  assert.equal(flameproofResult.minimumLevel, 119);
  assert.equal(flameproofResult.compliant, false);

  flameproof.weighting = "C";
  const mismatchResult = Model.evaluateSourceOutputRequirement(flameproof);
  assert.equal(mismatchResult.weightingMatches, false);
  assert.equal(mismatchResult.compliant, false);
});

test("project output criteria are inherited, editable, and overridable per source", () => {
  const project = Model.createProject("paging");
  project.sourceOutputRequirement = "outdoorWeatherproof";
  project.minimumSourceOutput = 126;
  const item = source({
    referenceSpl: 105,
    referenceDistance: 1,
    referencePower: 1,
    ratedPower: 80,
    weighting: "A",
    outputRequirement: "none",
  });
  let result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.inherited, true);
  assert.equal(result.minimumLevel, 126);
  assert.equal(result.compliant, false);

  project.minimumSourceOutput = 124;
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.compliant, true);

  item.outputRequirement = "outdoorFlameproof";
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.inherited, false);
  assert.equal(result.minimumLevel, 119);
  assert.equal(result.compliant, true);

  item.outputRequirement = "none";
  project.sourceOutputRequirement = "custom";
  project.minimumSourceOutput = 123.5;
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.inherited, true);
  assert.equal(result.minimumLevel, 123.5);
});

test("grid compliance separates below-target, compliant, and over-limit cells", () => {
  const project = simpleProject();
  project.width = 8;
  project.depth = 8;
  project.gridSpacing = 2;
  project.ambientLevel = 50;
  project.minimumLevel = 60;
  project.requiredMargin = 10;
  project.maximumLevel = 90;
  project.enforceMaximum = true;
  project.sources = [source({ x: 4, y: 4, referenceSpl: 85 })];
  const grid = Model.calculateGrid(project);
  const summary = Model.summarizeGrid(grid, project);
  assert.equal(grid.points.length, 16);
  assert.equal(summary.total, 16);
  assert.equal(summary.below + summary.compliant + summary.over + summary.empty, 16);
  assert.equal(summary.sourceCount, 1);
});
test("compliance optimizer returns a fully verified sparse grid", () => {
  const project = simpleProject();
  project.gridSpacing = 2;
  project.ambientLevel = 60;
  project.minimumLevel = 80;
  project.requiredMargin = 10;
  project.enforceMaximum = false;
  const result = Model.optimizePlacementGrid(
    project,
    "custom",
    { x: 0, y: 0, width: 20, depth: 20 },
    { designMargin: 3, includeExisting: false, alternateAzimuth: false, maxSources: 50 },
  );
  assert.equal(result.status, "calculated");
  assert.equal(result.assessment.compliant, true);
  assert.equal(result.assessment.compliantPercent, 100);
  assert.ok(result.layout.count >= 1 && result.layout.count <= 50);
});

test("compliance optimizer can recognize coverage from existing sources", () => {
  const project = simpleProject();
  project.ambientLevel = 50;
  project.minimumLevel = 70;
  project.requiredMargin = 10;
  project.enforceMaximum = false;
  project.sources = [source({ x: 10, y: 10, referenceSpl: 130 })];
  const result = Model.optimizePlacementGrid(
    project,
    "custom",
    { x: 0, y: 0, width: 20, depth: 20 },
    { designMargin: 3, includeExisting: true, maxSources: 50 },
  );
  assert.equal(result.status, "existing-compliant");
  assert.equal(result.layout.count, 0);
  assert.equal(result.assessment.compliant, true);
});

test("automatic placement always assigns zero-degree azimuth", () => {
  const layout = Model.createPlacementGrid({ x: 0, y: 0, width: 10, depth: 10 }, 2, 2);
  const sources = Model.createPlacementSources("custom", layout, { baseAzimuth: 75, alternateAzimuth: true });
  assert.ok(sources.length > 1);
  assert.ok(sources.every((item) => item.azimuth === 0));
});

test("horizontal beam edge follows the minus 6 dB convention", () => {
  const item = source({ azimuth: 0, beamWidth: 120, rearAttenuation: 20 });
  const radians = Model.degreesToRadians(60);
  const loss = Model.directivityLoss(item, 10 * Math.cos(radians), 10 * Math.sin(radians));
  assert.ok(Math.abs(loss - 6) < 0.001);
});

test("vertical beam edge follows the minus 6 dB convention", () => {
  const item = source({ z: 10, beamWidth: 360, verticalBeamWidth: 60, elevation: 0, rearAttenuation: 20 });
  const horizontalDistance = 10 / Math.tan(Model.degreesToRadians(30));
  const loss = Model.directivityLoss(item, horizontalDistance, 0, 0);
  assert.ok(Math.abs(loss - 6) < 0.001);
});

test("overlapping noise zones use the highest active ambient level", () => {
  const project = simpleProject();
  project.ambientLevel = 55;
  project.noiseZones = [
    { x: 0, y: 0, width: 10, depth: 10, level: 65, enabled: true },
    { x: 0, y: 0, width: 10, depth: 10, level: 60, enabled: true },
    { x: 0, y: 0, width: 10, depth: 10, level: 90, enabled: false },
  ];
  assert.equal(Model.noiseAtPoint(project, 5, 5), 65);
});

test("loop summary excludes disabled sources and applies amplifier headroom", () => {
  const project = simpleProject();
  project.amplifierHeadroom = 20;
  project.sources = [
    source({ loop: "L1", tapPower: 10 }),
    source({ loop: "L1", tapPower: 5 }),
    source({ loop: "L2", tapPower: 100, enabled: false }),
  ];
  const loops = Model.summarizeLoops(project);
  assert.deepEqual(loops, [{ name: "L1", count: 2, connectedLoad: 15, withHeadroom: 18 }]);
});

test("project sanitization clamps nested objects, strips unknown keys, and migrates legacy loss", () => {
  const project = Model.sanitizeProject({
    schemaVersion: 1,
    mode: "paging",
    width: 20,
    depth: 10,
    fixedLoss: 1,
    unknownTopLevel: "discard",
    sources: [{ presetKey: "custom", x: -5, y: 99, tapPower: 1e300, beamWidth: 999, verticalBeamWidth: 0, confidence: "sourced", unknown: true }],
    noiseZones: [{ x: -10, y: 0, width: 999, depth: 999, level: 999, requiredMargin: 999, minimumLevel: -10, unknown: true }],
    obstacles: [{ x: 19.95, y: 9.95, width: 999, depth: 999, height: 1e9, loss: -10, unknown: true }],
  });
  assert.equal(project.schemaVersion, 2);
  assert.equal(project.fixedLoss, 0);
  assert.equal("unknownTopLevel" in project, false);
  assert.equal(project.sources[0].x, 0);
  assert.equal(project.sources[0].y, 10);
  assert.equal(project.sources[0].tapPower, 1000000);
  assert.equal(project.sources[0].beamWidth, 360);
  assert.equal(project.sources[0].verticalBeamWidth, 1);
  assert.equal(project.sources[0].confidence, "user");
  assert.equal("unknown" in project.sources[0], false);
  assert.equal(project.noiseZones[0].level, 180);
  assert.equal(project.noiseZones[0].requiredMargin, 100);
  assert.equal(project.noiseZones[0].minimumLevel, 0);
  assert.equal("unknown" in project.noiseZones[0], false);
  assert.equal(project.obstacles[0].height, 1000);
  assert.equal(project.obstacles[0].loss, 0);
  assert.equal("unknown" in project.obstacles[0], false);
});

test("fixed loss defaults to zero while explicit schema v2 values are preserved", () => {
  assert.equal(Model.createProject("paging").fixedLoss, 0);
  assert.equal(Model.sanitizeProject({ schemaVersion: 2, mode: "paging", fixedLoss: 1 }).fixedLoss, 1);
});

test("source output requirements survive sanitization and reject unknown keys", () => {
  const preserved = Model.sanitizeProject({
    mode: "paging",
    sources: [{ presetKey: "custom", outputRequirement: "outdoorWeatherproof" }],
  });
  assert.equal(preserved.sources[0].outputRequirement, "outdoorWeatherproof");
  const rejected = Model.sanitizeProject({
    mode: "paging",
    sources: [{ presetKey: "custom", outputRequirement: "not-a-requirement" }],
  });
  assert.equal(rejected.sources[0].outputRequirement, "none");
});

test("editable project output criteria survive sanitization", () => {
  const project = Model.sanitizeProject({
    mode: "paging",
    sourceOutputRequirement: "custom",
    minimumSourceOutput: 127.5,
  });
  assert.equal(project.sourceOutputRequirement, "custom");
  assert.equal(project.minimumSourceOutput, 127.5);
  const rejected = Model.sanitizeProject({
    mode: "paging",
    sourceOutputRequirement: "unknown",
    minimumSourceOutput: 999,
  });
  assert.equal(rejected.sourceOutputRequirement, "none");
  assert.equal(rejected.minimumSourceOutput, 180);
});

test("batch removal deletes selected objects across categories only", () => {
  const project = simpleProject();
  project.sources = [source({ id: "source-a" }), source({ id: "source-b" })];
  project.noiseZones = [{ id: "noise-a" }, { id: "noise-b" }];
  project.obstacles = [{ id: "obstacle-a" }];
  const removed = Model.removeProjectObjects(project, [
    { type: "source", id: "source-a" },
    { type: "noise", id: "noise-b" },
    { type: "unknown", id: "obstacle-a" },
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(project.sources.map((item) => item.id), ["source-b"]);
  assert.deepEqual(project.noiseZones.map((item) => item.id), ["noise-a"]);
  assert.deepEqual(project.obstacles.map((item) => item.id), ["obstacle-a"]);
});

test("selection brush distance covers points along and beyond a segment", () => {
  assert.equal(Model.pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.ok(Math.abs(Model.pointSegmentDistance({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 5) < 1e-9);
});

test("selection rectangle returns device centers inside either drag direction", () => {
  const sources = [{ id: "a", x: 2, y: 3 }, { id: "b", x: 8, y: 9 }, { id: "c", x: 11, y: 5 }];
  assert.deepEqual(Model.sourceIdsInsideRectangle(sources, { x: 10, y: 10, width: -10, depth: -10 }), ["a", "b"]);
});

test("batch source edits can rotate relative azimuths and update shared engineering fields", () => {
  const sources = [
    source({ azimuth: 350, z: 3, tapPower: 25, ratedPower: 25, loop: "L1", enabled: true }),
    source({ azimuth: 10, z: 4, tapPower: 15, ratedPower: 15, loop: "L2", enabled: true }),
  ];
  const changed = Model.applySourceBatchEdits(sources, {
    azimuthMode: "offset",
    azimuth: 20,
    z: 5,
    ratedPower: 10,
    tapPower: 12,
    beamWidth: 90,
    loop: "L3",
    enabled: false,
  });
  assert.equal(changed, 2);
  assert.deepEqual(sources.map((item) => item.azimuth), [10, 30]);
  assert.deepEqual(sources.map((item) => item.z), [5, 5]);
  assert.deepEqual(sources.map((item) => item.tapPower), [10, 10]);
  assert.deepEqual(sources.map((item) => item.beamWidth), [90, 90]);
  assert.deepEqual(sources.map((item) => item.loop), ["L3", "L3"]);
  assert.ok(sources.every((item) => item.enabled === false));
});

test("batch source edits set the same absolute azimuth on every selected source", () => {
  const sources = [source({ azimuth: 35 }), source({ azimuth: 145 })];
  Model.applySourceBatchEdits(sources, { azimuthMode: "set", azimuth: 270 });
  assert.deepEqual(sources.map((item) => item.azimuth), [270, 270]);
});

test("batch power validation detects tap and rated power conflicts", () => {
  const sources = [
    source({ tapPower: 10, ratedPower: 20 }),
    source({ tapPower: 15, ratedPower: 15 }),
  ];
  assert.deepEqual(Model.validateSourceBatchPower(sources, { tapPower: 18 }), {
    valid: false,
    violationCount: 1,
    hasTapPower: true,
    hasRatedPower: false,
    tapPower: 18,
    ratedPower: null,
  });
  assert.equal(Model.validateSourceBatchPower(sources, { tapPower: 25, ratedPower: 30 }).valid, true);
  assert.equal(Model.validateSourceBatchPower(sources, { ratedPower: 12 }).violationCount, 1);
});

test("valid batch tap power is applied to every selected source", () => {
  const sources = [
    source({ tapPower: 10, ratedPower: 20 }),
    source({ tapPower: 15, ratedPower: 30 }),
  ];
  assert.equal(Model.validateSourceBatchPower(sources, { tapPower: 18 }).valid, true);
  Model.applySourceBatchEdits(sources, { tapPower: 18 });
  assert.deepEqual(sources.map((item) => item.tapPower), [18, 18]);
});

test("batch source edits assign an outdoor output requirement", () => {
  const sources = [source(), source()];
  Model.applySourceBatchEdits(sources, { outputRequirement: "outdoorFlameproof" });
  assert.deepEqual(sources.map((item) => item.outputRequirement), ["outdoorFlameproof", "outdoorFlameproof"]);
});

test("group translation is clamped by the outermost selected object", () => {
  const delta = Model.clampGroupTranslation([
    { x: 2, y: 4 },
    { x: 15, y: 12, width: 4, depth: 5 },
  ], 10, -10, 20, 20);
  assert.deepEqual(delta, { x: 1, y: -4 });
});

test("rectangle resize keeps the opposite corner fixed and respects plan bounds", () => {
  assert.deepEqual(
    Model.resizeRectangle({ x: 5, y: 5, width: 10, depth: 8 }, "nw", { x: 2, y: 3 }, { width: 20, depth: 20 }),
    { x: 2, y: 3, width: 13, depth: 10 },
  );
  assert.deepEqual(
    Model.resizeRectangle({ x: 5, y: 5, width: 10, depth: 8 }, "se", { x: 99, y: 99 }, { width: 20, depth: 20 }),
    { x: 5, y: 5, width: 15, depth: 15 },
  );
  assert.deepEqual(
    Model.resizeRectangle({ x: 5, y: 5, width: 10, depth: 8 }, "e", { x: 18, y: 1 }, { width: 20, depth: 20 }),
    { x: 5, y: 5, width: 13, depth: 8 },
  );
  assert.deepEqual(
    Model.resizeRectangle({ x: 5, y: 5, width: 10, depth: 8 }, "n", { x: 1, y: 2 }, { width: 20, depth: 20 }),
    { x: 5, y: 2, width: 10, depth: 11 },
  );
});
