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

test("proposal bidding mode adds acoustic reserve to project and noise-zone targets", () => {
  const project = simpleProject();
  project.ambientLevel = 80;
  project.minimumLevel = 0;
  project.requiredMargin = 10;
  assert.equal(Model.targetForNoise(project, 80), 90);
  project.biddingModeEnabled = true;
  project.biddingAcousticReserve = 3;
  assert.equal(Model.targetForNoise(project, 80), 93);
  assert.equal(Model.targetForNoiseZone(project, { level: 70, requiredMargin: 5 }), 78);
});

test("proposal bidding estimate applies quantity, load, amplifier, and loose-spare allowances", () => {
  const project = simpleProject();
  project.biddingModeEnabled = true;
  project.biddingQuantityAllowance = 25;
  project.biddingAmplifierHeadroom = 25;
  project.biddingLooseSparePercent = 5;
  const estimate = Model.calculateBiddingEstimate(project, { sourceCount: 40, connectedLoad: 1000 });
  assert.equal(estimate.installedQuantity, 50);
  assert.equal(estimate.quantityAllowance, 10);
  assert.equal(estimate.looseSpareQuantity, 3);
  assert.equal(estimate.purchaseQuantity, 53);
  assert.equal(estimate.estimatedConnectedLoad, 1250);
  assert.equal(estimate.amplifierCapacity, 1562.5);
});

test("maximum exposure remains visible when a proposal target is also unmet", () => {
  const project = simpleProject();
  project.ambientLevel = 105;
  project.requiredMargin = 10;
  project.minimumLevel = 0;
  project.maximumLevel = 110;
  project.enforceMaximum = true;
  project.sources = [source({ referenceSpl: 132 })];
  const result = Model.calculatePoint(project, 10, 0);
  assert.equal(result.level, 112);
  assert.equal(result.target, 115);
  assert.equal(result.status, "over");
  const summary = Model.summarizeGrid({ points: [result], spacing: 1 }, project);
  assert.equal(summary.audiblePercent, 0);
  assert.equal(summary.overPercent, 100);
});
test("proposal bidding fields survive JSON sanitization", () => {
  const project = Model.sanitizeProject({
    mode: "publicAddress",
    biddingModeEnabled: true,
    biddingAcousticReserve: 4,
    biddingQuantityAllowance: 30,
    biddingAmplifierHeadroom: 35,
    biddingLooseSparePercent: 8,
  });
  assert.equal(project.biddingModeEnabled, true);
  assert.equal(project.biddingAcousticReserve, 4);
  assert.equal(project.biddingQuantityAllowance, 30);
  assert.equal(project.biddingAmplifierHeadroom, 35);
  assert.equal(project.biddingLooseSparePercent, 8);
  const session = Model.buildMtoProjectSession(project);
  assert.equal(session.biddingModeEnabled, true);
  assert.equal(session.biddingQuantityAllowance, 30);
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
  project.minimumWeatherproofOutput = 126;
  project.minimumFlameproofOutput = 125;
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

  project.minimumWeatherproofOutput = 124;
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.compliant, true);

  item.outputRequirement = "outdoorFlameproof";
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.inherited, false);
  assert.equal(result.minimumLevel, 125);
  assert.equal(result.compliant, false);

  project.minimumFlameproofOutput = 119;
  result = Model.evaluateSourceOutputRequirement(item, project);
  assert.equal(result.minimumLevel, 119);
  assert.equal(result.compliant, true);
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
  assert.equal(project.schemaVersion, 3);
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
    sourceOutputRequirement: "outdoorWeatherproof",
    minimumWeatherproofOutput: 127.5,
    minimumFlameproofOutput: 121,
  });
  assert.equal(project.sourceOutputRequirement, "outdoorWeatherproof");
  assert.equal(project.minimumWeatherproofOutput, 127.5);
  assert.equal(project.minimumFlameproofOutput, 121);
  const rejected = Model.sanitizeProject({
    mode: "paging",
    sourceOutputRequirement: "unknown",
    minimumWeatherproofOutput: 999,
    minimumFlameproofOutput: -10,
  });
  assert.equal(rejected.sourceOutputRequirement, "none");
  assert.equal(rejected.minimumWeatherproofOutput, 180);
  assert.equal(rejected.minimumFlameproofOutput, 0);

  const migrated = Model.sanitizeProject({
    mode: "paging",
    sourceOutputRequirement: "custom",
    minimumSourceOutput: 126.5,
  });
  assert.equal(migrated.sourceOutputRequirement, "none");
  assert.equal(migrated.minimumWeatherproofOutput, 126.5);
  assert.equal(migrated.minimumFlameproofOutput, 126.5);
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

test("single source power edits retain tap changes and reconcile rated power", () => {
  const item = source({ tapPower: 25, ratedPower: 25 });
  let result = Model.applySourcePowerEdit(item, "tapPower", 50);
  assert.equal(item.tapPower, 50);
  assert.equal(item.ratedPower, 50);
  assert.equal(result.ratedRaised, true);

  result = Model.applySourcePowerEdit(item, "tapPower", 10);
  assert.equal(item.tapPower, 10);
  assert.equal(item.ratedPower, 50);
  assert.equal(result.ratedRaised, false);

  Model.applySourcePowerEdit(item, "tapPower", 40);
  result = Model.applySourcePowerEdit(item, "ratedPower", 20);
  assert.equal(item.ratedPower, 20);
  assert.equal(item.tapPower, 20);
  assert.equal(result.tapReduced, true);
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

test("project export satisfies the Telecom MTO 2.4 session contract and maps source layout", () => {
  const project = simpleProject();
  project.title = "Compatibility";
  project.width = 20;
  project.depth = 10;
  project.sources = [source({
    id: "horn-1",
    name: "SPK-001",
    model: "Horn X",
    x: 5,
    y: 4,
    z: 3,
    azimuth: 270,
    elevation: -8,
    tapPower: 25,
    ratedPower: 25,
    loop: "L2",
    outputRequirement: "outdoorWeatherproof",
  })];
  const session = Model.buildMtoProjectSession(project);
  assert.equal(session.version, "2.4");
  assert.ok(session.calibration);
  assert.ok(Array.isArray(session.materials));
  assert.ok(Array.isArray(session.takeoffs));
  assert.equal(session.materials.length, 1);
  assert.equal(session.takeoffs.length, 1);
  assert.deepEqual(session.takeoffs[0].points[0], { x: 50, y: 40 });
  assert.ok(Math.abs(session.takeoffs[0].angle - (3 * Math.PI) / 2) < 1e-9);
  assert.equal(session.takeoffs[0].metadata.tagName, "SPK-001");
  assert.equal(session.takeoffs[0].metadata.panelCircuit, "L2");
  assert.equal(session.takeoffs[0].metadata.powerW, "25");
  assert.equal(session.takeoffs[0].metadata.pagaAcoustic.outputRequirement, "outdoorWeatherproof");
  assert.equal(session.materials[0].coverage.type, "paga");
});

test("compatible session stores an imported background once and restores it on Sound Coverage import", () => {
  const project = simpleProject();
  const backgroundImage = "data:image/png;base64,AAAA";
  project.width = 20;
  project.depth = 10;
  project.backgroundImage = backgroundImage;
  project.backgroundName = "plan.png";
  project.backgroundPixelWidth = 200;
  project.backgroundPixelHeight = 100;
  const session = Model.buildMtoProjectSession(project);
  assert.equal(session.backgroundImage, "");
  assert.equal(session.drawingSource.content, backgroundImage);
  assert.equal(session.drawingSource.name, "plan.png");
  assert.deepEqual(session.canvasState, { width: 200, height: 100, originalPageWidth: 200 });
  const restored = Model.sanitizeProject(Model.soundCoverageProjectFromSession(session));
  assert.equal(restored.backgroundImage, backgroundImage);
  assert.equal(restored.backgroundName, "plan.png");
  assert.equal(restored.backgroundPixelWidth, 200);
  assert.equal(restored.backgroundPixelHeight, 100);
});

test("compatible session shares MTO materials only when source acoustic configurations match", () => {
  const project = simpleProject();
  project.sources = [
    source({ id: "a", name: "SPK-A", x: 1, y: 1, tapPower: 10, ratedPower: 25 }),
    source({ id: "b", name: "SPK-B", x: 2, y: 2, tapPower: 10, ratedPower: 25 }),
    source({ id: "c", name: "SPK-C", x: 3, y: 3, tapPower: 20, ratedPower: 25 }),
  ];
  const session = Model.buildMtoProjectSession(project);
  assert.equal(session.takeoffs.length, 3);
  assert.equal(session.materials.length, 2);
  assert.equal(session.takeoffs[0].materialId, session.takeoffs[1].materialId);
  assert.notEqual(session.takeoffs[0].materialId, session.takeoffs[2].materialId);
});

test("legacy Sound Coverage JSON remains importable through the compatibility helper", () => {
  const project = simpleProject();
  project.title = "Legacy project";
  assert.equal(Model.soundCoverageProjectFromSession(project).title, "Legacy project");
});

test("Telecom MTO Material Configuration imports complete PAGA placement profiles", () => {
  const profiles = Model.importPagaMaterialProfiles({
    version: "1.1",
    units: "m",
    materials: [{
      id: "mat-speaker-25w",
      name: "Outdoor Horn 25 W",
      type: "point",
      category: "PAGA",
      color: "#eab308",
      unit: "pcs",
      layer: "E-PA-EQUP-HORN",
      symbol: "speaker",
      coverage: {
        type: "paga",
        enabled: true,
        sensitivity: 105,
        power: 25,
        spl: 119,
        ambientNoise: 80,
        targetMargin: 10,
        radiusM: 28.12,
        indoorAttenuation: false,
        dispersionAngle: 120,
        mountingHeightM: 0,
        listenerEarHeightM: 0,
      },
    }],
  });

  assert.equal(profiles.length, 1);
  const preset = Model.devicePresetFromMtoMaterial(profiles[0]);
  assert.equal(preset.key, "mto:mat-speaker-25w");
  assert.equal(preset.mtoMaterialId, "mat-speaker-25w");
  assert.equal(preset.referenceSpl, 105);
  assert.equal(preset.tapPower, 25);
  assert.equal(preset.beamWidth, 120);
});

test("coverage design basis registers the complete supplied 25 W speaker profile", () => {
  const project = simpleProject();
  project.receiverHeight = 0;
  project.materialProfiles = Model.importPagaMaterialProfiles({
    materials: [{
      id: "mat-speaker-25w",
      name: "Outdoor Horn 25 W",
      type: "point",
      coverage: {
        type: "paga",
        sensitivity: 105,
        power: 25,
        spl: 119,
        ambientNoise: 80,
        targetMargin: 10,
        radiusM: 28.12,
        indoorAttenuation: false,
        dispersionAngle: 120,
        mountingHeightM: 0,
        listenerEarHeightM: 0,
      },
    }],
  });
  const preset = Model.devicePresetFromMtoMaterial(project.materialProfiles[0]);
  const item = Model.instantiateDevice(preset, { z: 0 });
  const basis = Model.coverageDesignBasis(project, item);

  assert.equal(basis.type, "paga");
  assert.equal(basis.materialId, "mat-speaker-25w");
  assert.equal(basis.sensitivity, 105);
  assert.equal(basis.tapPower, 25);
  assert.ok(Math.abs(basis.splAtOneMetre - 118.979) < 0.001);
  assert.equal(basis.ambientNoise, 80);
  assert.equal(basis.targetMargin, 10);
  assert.equal(basis.targetSpl, 90);
  assert.equal(basis.attenuationModel, "freefield");
  assert.equal(basis.mountingHeightM, 0);
  assert.equal(basis.listenerEarHeightM, 0);
  assert.equal(basis.verticalSeparationM, 0);
  assert.equal(basis.dispersionAngle, 120);
  assert.ok(Math.abs(basis.planRadiusM - 28.117) < 0.001);
  assert.ok(Math.abs(basis.designSpacingM - 39.763) < 0.001);
});

test("MTO session export reuses an imported material and includes complete design fields", () => {
  const project = simpleProject();
  project.receiverHeight = 0;
  project.materialProfiles = Model.importPagaMaterialProfiles({
    materials: [{
      id: "existing-paga-material",
      name: "Existing PAGA Horn",
      type: "point",
      category: "PAGA",
      color: "#eab308",
      unit: "pcs",
      layer: "E-PA-EQUP-HORN",
      symbol: "speaker",
      coverage: {
        type: "paga",
        sensitivity: 105,
        power: 25,
        spl: 119,
        ambientNoise: 80,
        targetMargin: 10,
        radiusM: 28.12,
        indoorAttenuation: false,
        dispersionAngle: 120,
        mountingHeightM: 0,
        listenerEarHeightM: 0,
      },
    }],
  });
  const preset = Model.devicePresetFromMtoMaterial(project.materialProfiles[0]);
  project.sources = [Model.instantiateDevice(preset, { id: "source-existing", name: "SPK-101", z: 0 })];

  const session = Model.buildMtoProjectSession(project);

  assert.equal(session.materials.length, 1);
  assert.equal(session.materials[0].id, "existing-paga-material");
  assert.equal(session.materials[0].name, "Existing PAGA Horn");
  assert.equal(session.materials[0].pagaImportedMaterial, true);
  assert.equal(session.takeoffs[0].materialId, "existing-paga-material");
  assert.equal(session.materials[0].coverage.targetSpl, 90);
  assert.equal(session.materials[0].coverage.mountingHeightM, 0);
  assert.equal(session.materials[0].coverage.listenerEarHeightM, 0);
  assert.equal(session.materials[0].coverage.verticalSeparationM, 0);
  assert.ok(Math.abs(session.materials[0].coverage.planRadiusM - 28.117) < 0.001);
  assert.ok(Math.abs(session.materials[0].coverage.designSpacingM - 39.763) < 0.001);
  assert.equal(session.takeoffs[0].metadata.pagaAcoustic.mtoMaterialId, "existing-paga-material");
  assert.equal(session.takeoffs[0].metadata.pagaAcoustic.designBasis.dispersionAngle, 120);
});

test("project sanitization preserves imported material profiles and source material links", () => {
  const project = simpleProject();
  project.materialProfiles = Model.importPagaMaterialProfiles({
    materials: [{
      id: "linked-material",
      name: "Linked PAGA material",
      type: "point",
      coverage: { type: "paga", sensitivity: 100, power: 10, ambientNoise: 70, targetMargin: 10 },
    }],
  });
  const preset = Model.devicePresetFromMtoMaterial(project.materialProfiles[0]);
  project.sources = [Model.instantiateDevice(preset)];

  const sanitized = Model.sanitizeProject(project);

  assert.equal(sanitized.schemaVersion, 3);
  assert.equal(sanitized.materialProfiles[0].id, "linked-material");
  assert.equal(sanitized.sources[0].mtoMaterialId, "linked-material");
  assert.equal(sanitized.sources[0].presetKey, "mto:linked-material");
});

test("Telecom MTO 2.4 project material import preserves CTGU speaker specifications and derives placement defaults", () => {
  const customSymbol = {
    key: "custom_ctgu_speaker",
    name: "CTGU PAGA Speaker",
    dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  };
  const payload = {
    version: "2.4",
    materials: [{
      id: "mat-paga-speaker-a",
      name: "OUTDOOR PAGA LOUDSPEAKER A",
      type: "point",
      category: "PAGA",
      color: "#F59E0B",
      unit: "pcs",
      layer: "E-PA-EQUP-SPKR",
      symbol: "custom_ctgu_speaker",
      network: "A",
      networkColor: "Orange",
      coverage: {
        type: "paga",
        enabled: true,
        spl: 119,
        sensitivity: 105.021,
        power: 25,
        ambientNoise: 90,
        targetMargin: 15,
        radiusM: 5,
        dispersionAngle: 180,
        color: "#F59E0B44",
      },
      technicalSpec: {
        nominalPowerW: 25,
        selectableTapsW: [12, 25],
        weatherproofMinSPLdBA1mAt25W: 124,
        flameproofMinSPLdBA1mAt25W: 119,
        minimumIngressProtection: "IP65",
        mounting: "Wall or steel structure mounted",
        hazardousArea: "Zone 1/Zone 2",
        bidNoiseZoning: { general: "85 dBA / 12 m", high: "90 dBA / 8 m" },
        finalDesignRequirement: "Noise map + acoustic/STI study",
      },
    }],
    takeoffs: [
      { materialId: "mat-paga-speaker-a", metadata: { mountingHeightM: 5 } },
      { materialId: "mat-paga-speaker-a", metadata: { mountingHeightM: "5" } },
      { materialId: "mat-paga-speaker-a", metadata: { mountingHeightM: 6 } },
    ],
    customSvgSymbols: [customSymbol],
  };

  const profiles = Model.importPagaMaterialProfiles(payload);
  assert.equal(profiles.length, 1);
  const profile = profiles[0];
  assert.equal(profile.network, "A");
  assert.equal(profile.networkColor, "Orange");
  assert.deepEqual(profile.technicalSpec.selectableTapsW, [12, 25]);
  assert.equal(profile.technicalSpec.minimumIngressProtection, "IP65");
  assert.equal(profile.sourceDefaults.mountingHeightM, 5);
  assert.equal(profile.sourceDefaults.loop, "PAGA-A");
  assert.equal(profile.sourceDefaults.placementCount, 3);
  assert.deepEqual(profile.customSvgSymbol, customSymbol);
  assert.equal(profile.coverage.verticalSeparationM, 3.5);
  assert.ok(Math.abs(profile.coverage.slantRadiusM - Math.hypot(5, 3.5)) < 1e-9);

  const preset = Model.devicePresetFromMtoMaterial(profile);
  const placed = Model.instantiateDevice(preset);
  assert.equal(placed.z, 5);
  assert.equal(placed.loop, "PAGA-A");
  assert.equal(placed.ratedPower, 25);

  const project = simpleProject();
  project.materialProfiles = profiles;
  project.sources = [placed];
  const session = Model.buildMtoProjectSession(project);
  assert.equal(session.materials[0].id, "mat-paga-speaker-a");
  assert.equal(session.materials[0].network, "A");
  assert.deepEqual(session.materials[0].technicalSpec.selectableTapsW, [12, 25]);
  assert.equal(session.materials[0].customSvgSymbol, undefined);
  assert.equal(session.materials[0].sourceDefaults, undefined);
  assert.deepEqual(session.customSvgSymbols, [customSymbol]);
});

test("A/B group switches and a selected circuit outage change the acoustic result", () => {
  const project = simpleProject();
  project.sources = [
    source({ id: "a-1", redundancyGroup: "A", loop: "C1" }),
    source({ id: "b-1", redundancyGroup: "B", loop: "C1" }),
  ];

  const normal = Model.calculatePoint(project, 10, 0);
  assert.ok(Math.abs(normal.level - 83.0103) < 0.001);

  project.scenarioGroupBEnabled = false;
  const groupBOut = Model.calculatePoint(project, 10, 0);
  assert.ok(Math.abs(groupBOut.level - 80) < 0.001);

  project.scenarioGroupBEnabled = true;
  project.scenarioOutageCircuit = "A::C1";
  const circuitAOut = Model.calculatePoint(project, 10, 0);
  assert.ok(Math.abs(circuitAOut.level - 80) < 0.001);
  assert.equal(Model.sourceActiveInScenario(project, project.sources[0]), false);
  assert.equal(Model.sourceActiveInScenario(project, project.sources[1]), true);
});

test("circuit summary separates identical circuit names by A/B group and derives loads", () => {
  const project = simpleProject();
  project.amplifierHeadroom = 20;
  project.scenarioOutageCircuit = "B::C1";
  project.sources = [
    source({ redundancyGroup: "A", loop: "C1", tapPower: 10 }),
    source({ redundancyGroup: "A", loop: "C1", tapPower: 5 }),
    source({ redundancyGroup: "B", loop: "C1", tapPower: 20 }),
  ];

  const circuits = Model.summarizeCircuits(project);
  assert.equal(circuits.length, 2);
  assert.deepEqual(circuits.map(({ key, count, connectedLoad, withHeadroom, scenarioActive }) => ({ key, count, connectedLoad, withHeadroom, scenarioActive })), [
    { key: "A::C1", count: 2, connectedLoad: 15, withHeadroom: 18, scenarioActive: true },
    { key: "B::C1", count: 1, connectedLoad: 20, withHeadroom: 24, scenarioActive: false },
  ]);
});

test("outage scenarios do not reduce the installed bidding basis", () => {
  const project = simpleProject();
  project.biddingModeEnabled = true;
  project.biddingQuantityAllowance = 0;
  project.scenarioGroupBEnabled = false;
  project.sources = [
    source({ redundancyGroup: "A", loop: "A-C1", tapPower: 10 }),
    source({ redundancyGroup: "B", loop: "B-C1", tapPower: 20 }),
  ];
  const point = Model.calculatePoint(project, 10, 0);
  const summary = Model.summarizeGrid({ points: [point], spacing: 1 }, project);

  assert.equal(summary.sourceCount, 1);
  assert.equal(summary.designSourceCount, 2);
  assert.equal(summary.connectedLoad, 10);
  assert.equal(summary.designConnectedLoad, 30);
  assert.equal(summary.bidding.modelledQuantity, 2);
  assert.equal(summary.bidding.estimatedConnectedLoad, 30);
});

test("project JSON sanitization preserves redundancy scenario and speaker assignment", () => {
  const project = Model.sanitizeProject({
    mode: "paging",
    scenarioGroupAEnabled: false,
    scenarioGroupBEnabled: true,
    speakersPerCircuit: 12,
    scenarioOutageCircuit: "B::B-C2",
    sources: [{ redundancyGroup: "b", loop: "B-C2" }],
  });

  assert.equal(project.scenarioGroupAEnabled, false);
  assert.equal(project.scenarioGroupBEnabled, true);
  assert.equal(project.speakersPerCircuit, 12);
  assert.equal(project.scenarioOutageCircuit, "B::B-C2");
  assert.equal(project.sources[0].redundancyGroup, "B");
  assert.equal(project.sources[0].loop, "B-C2");
});

test("automatic placement alternates A/B speakers and assigns eight per group circuit", () => {
  const points = Array.from({ length: 18 }, (_, index) => ({ x: index, y: 0 }));
  const sources = Model.createPlacementSources("custom", { points });

  assert.equal(sources[0].redundancyGroup, "A");
  assert.equal(sources[0].loop, "A-C1");
  assert.equal(sources[1].redundancyGroup, "B");
  assert.equal(sources[1].loop, "B-C1");
  assert.equal(sources[16].redundancyGroup, "A");
  assert.equal(sources[16].loop, "A-C2");
  assert.equal(sources[17].redundancyGroup, "B");
  assert.equal(sources[17].loop, "B-C2");
  const smallerCircuits = Model.createPlacementSources("custom", { points: points.slice(0, 6) }, { speakersPerCircuit: 2 });
  assert.equal(smallerCircuits[4].loop, "A-C2");
  assert.equal(smallerCircuits[5].loop, "B-C2");
  const reassigned = Array.from({ length: 7 }, () => source({ redundancyGroup: "A", loop: "OLD" }));
  Model.assignSourcesToCircuits(reassigned, 2);
  assert.deepEqual(reassigned.map((item) => `${item.redundancyGroup}:${item.loop}`), ["A:A-C1", "B:B-C1", "A:A-C1", "B:B-C1", "A:A-C2", "B:B-C2", "A:A-C2"]);
});

test("Telecom MTO export carries speaker group and circuit metadata", () => {
  const project = simpleProject();
  project.sources = [source({ redundancyGroup: "B", loop: "B-C3" })];
  const session = Model.buildMtoProjectSession(project);
  const acoustic = session.takeoffs[0].metadata.pagaAcoustic;

  assert.equal(acoustic.redundancyGroup, "B");
  assert.equal(acoustic.circuit, "B-C3");
  assert.equal(acoustic.circuitKey, "B::B-C3");
});
test("dedicated circuit amplifier sizing rounds each circuit and adds A/B standby quantities", () => {
  const project = simpleProject();
  project.amplifierUnitRating = 500;
  project.amplifierMaxLoadPercent = 80;
  project.amplifierAllocationMode = "perCircuit";
  project.amplifierStandbyPerGroup = 1;
  project.amplifierLooseSparePercent = 10;
  project.sources = [
    source({ redundancyGroup: "A", loop: "A-C1", tapPower: 100, ratedPower: 100 }),
    source({ redundancyGroup: "A", loop: "A-C2", tapPower: 300, ratedPower: 300 }),
    source({ redundancyGroup: "B", loop: "B-C1", tapPower: 401, ratedPower: 401 }),
  ];

  const plan = Model.calculateAmplifierPlan(project);
  assert.equal(plan.usableCapacityPerUnit, 400);
  assert.equal(plan.designLoad, 801);
  assert.equal(plan.onlineQuantity, 4);
  assert.equal(plan.standbyQuantity, 2);
  assert.equal(plan.installedQuantity, 6);
  assert.equal(plan.looseSpareQuantity, 1);
  assert.equal(plan.purchaseQuantity, 7);
  assert.equal(plan.groups[0].onlineQuantity, 2);
  assert.equal(plan.groups[1].onlineQuantity, 2);
  assert.equal(plan.rows.find((row) => row.key === "B::B-C1").requiresCircuitSplit, true);
});

test("pooled A/B amplifier sizing rounds each redundancy bank instead of every circuit", () => {
  const project = simpleProject();
  project.amplifierUnitRating = 500;
  project.amplifierMaxLoadPercent = 80;
  project.amplifierAllocationMode = "pooledByGroup";
  project.amplifierStandbyPerGroup = 1;
  project.amplifierLooseSparePercent = 10;
  project.sources = [
    source({ redundancyGroup: "A", loop: "A-C1", tapPower: 100, ratedPower: 100 }),
    source({ redundancyGroup: "A", loop: "A-C2", tapPower: 300, ratedPower: 300 }),
    source({ redundancyGroup: "B", loop: "B-C1", tapPower: 401, ratedPower: 401 }),
  ];

  const plan = Model.calculateAmplifierPlan(project);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.onlineQuantity, 3);
  assert.equal(plan.standbyQuantity, 2);
  assert.equal(plan.installedQuantity, 5);
  assert.equal(plan.looseSpareQuantity, 1);
  assert.equal(plan.purchaseQuantity, 6);
});

test("amplifier design uses the bidding speaker allowance but not the selected outage scenario", () => {
  const project = simpleProject();
  project.biddingModeEnabled = true;
  project.biddingQuantityAllowance = 50;
  project.amplifierUnitRating = 250;
  project.amplifierMaxLoadPercent = 80;
  project.amplifierStandbyPerGroup = 0;
  project.scenarioGroupBEnabled = false;
  project.sources = [
    source({ redundancyGroup: "A", loop: "A-C1", tapPower: 150, ratedPower: 150 }),
    source({ redundancyGroup: "B", loop: "B-C1", tapPower: 150, ratedPower: 150 }),
  ];

  const plan = Model.calculateAmplifierPlan(project);
  assert.equal(plan.quantityLoadScale, 1.5);
  assert.equal(plan.biddingHeadroomFactor, 1.25);
  assert.equal(plan.loadScale, 1.875);
  assert.equal(plan.designLoad, 562.5);
  assert.equal(plan.scenarioLoad, 150);
  assert.equal(plan.onlineQuantity, 4);
  assert.equal(plan.installedSpeakerCount, 3);
});

test("amplifier settings survive project JSON sanitization", () => {
  const project = Model.sanitizeProject({
    mode: "paging",
    amplifierUnitRating: 1000,
    amplifierMaxLoadPercent: 75,
    amplifierAllocationMode: "pooledByGroup",
    amplifierStandbyPerGroup: 2,
    amplifierLooseSparePercent: 15,
  });

  assert.equal(project.amplifierUnitRating, 1000);
  assert.equal(project.amplifierMaxLoadPercent, 75);
  assert.equal(project.amplifierAllocationMode, "pooledByGroup");
  assert.equal(project.amplifierStandbyPerGroup, 2);
  assert.equal(project.amplifierLooseSparePercent, 15);
});