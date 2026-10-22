"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cropPixels } = require("../src/shot");

test("cropPixels maps a view rectangle onto the captured bitmap", () => {
  const rect = cropPixels(
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { x: 10, y: 20, width: 100, height: 50 },
  );
  assert.deepEqual(rect, { x: 20, y: 40, width: 200, height: 100 });
});

test("cropPixels clamps a rectangle that leaves the view", () => {
  const rect = cropPixels(
    { width: 800, height: 600 },
    { width: 800, height: 600 },
    { x: 760, y: 580, width: 80, height: 40 },
  );
  assert.deepEqual(rect, { x: 760, y: 580, width: 40, height: 20 });
});

test("cropPixels rejects a sliver and a missing image", () => {
  assert.equal(cropPixels({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 1, y: 1, width: 1, height: 40 }), null);
  assert.equal(cropPixels({ width: 100, height: 100 }, { width: 0, height: 100 }, { x: 0, y: 0, width: 10, height: 10 }), null);
});
