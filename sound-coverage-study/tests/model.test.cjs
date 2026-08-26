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
    noiseZones: [{ x: -10, y: 0, width: 999, depth: 999, level: 999, unknown: true }],
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
  assert.equal("unknown" in project.noiseZones[0], false);
  assert.equal(project.obstacles[0].height, 1000);
  assert.equal(project.obstacles[0].loss, 0);
  assert.equal("unknown" in project.obstacles[0], false);
});

test("fixed loss defaults to zero while explicit schema v2 values are preserved", () => {
  assert.equal(Model.createProject("paging").fixedLoss, 0);
  assert.equal(Model.sanitizeProject({ schemaVersion: 2, mode: "paging", fixedLoss: 1 }).fixedLoss, 1);
});
