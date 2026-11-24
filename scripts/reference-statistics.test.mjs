import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-statistics/main.ts";
import manifest from "../packages/plugin-sdk/examples/reference-statistics/manifest.json" with { type: "json" };

function handler() {
  let installed;
  register({
    actions: {
      register(id, run) {
        assert.equal(id, manifest.contributes.actions[0].actionId);
        installed = run;
      },
    },
    contributions: { register() {} },
  });
  assert.equal(typeof installed, "function");
  return (params, signal = new AbortController().signal) =>
    installed({ params }, { signal });
}

const series = {
  firstPosition: "9007199254740993",
  expectedSlots: 5,
  unit: "V",
  samples: [
    { position: "9007199254740997", value: 4 },
    { position: "9007199254740993", value: 2 },
    { position: "9007199254740995", value: 8 },
  ],
  window: { kind: "count", length: "3", step: "2" },
};

test("an overlapping count window gives precise positions and clips the last denominator", () => {
  assert.ok(
    validateNodePackageManifest(manifest),
    JSON.stringify(validateNodePackageManifest.errors),
  );
  const ajv = new Ajv();
  const [{ inputSchema, outputSchema }] = manifest.contributes.actions;
  assert.ok(ajv.validate(inputSchema, series), JSON.stringify(ajv.errors));
  const report = handler()(series);
  assert.ok(ajv.validate(outputSchema, report), JSON.stringify(ajv.errors));
  assert.equal(report.unit, "V");
  assert.deepEqual(
    report.windows.map(
      ({
        fromPosition,
        toPosition,
        partial,
        expectedCount,
        validCount,
        missingCount,
        missingRate,
        metrics,
      }) => [
        fromPosition,
        toPosition,
        partial,
        expectedCount,
        validCount,
        missingCount,
        missingRate,
        metrics.average,
      ],
    ),
    [
      ["9007199254740993", "9007199254740996", false, 3, 2, 1, 1 / 3, 5],
      ["9007199254740995", "9007199254740998", false, 3, 2, 1, 1 / 3, 6],
      ["9007199254740997", "9007199254740998", true, 1, 1, 0, 0, 4],
    ],
  );
  assert.equal(report.windows[0].metrics.deviation, 3);
  assert.equal(report.windows[0].metrics.p50, 5);
});

test("time windows use a half-open grid and distinguish lost samples from unscheduled positions", () => {
  const params = {
    firstPosition: "10",
    expectedSlots: 3,
    samples: [
      { position: "10", value: 4 },
      { position: "12", value: 8 },
    ],
    window: {
      kind: "time",
      clockId: "capture-source",
      originMonoNs: "18000000000000000000",
      periodNs: "4",
      length: "3",
      step: "3",
    },
  };
  const invoke = handler();
  const report = invoke(params);
  assert.equal(report.clockId, "capture-source");
  assert.equal(report.periodNs, "4");
  assert.deepEqual(
    report.windows.map(({ expectedCount, missingRate }) => [
      expectedCount,
      missingRate,
    ]),
    [
      [1, 0],
      [1, 1],
      [1, 0],
      [0, null],
    ],
  );
  assert.equal(report.windows[1].metrics, null);
  assert.deepEqual(report.windows[3], {
    fromPosition: "13",
    toPosition: "13",
    fromMonoNs: "18000000000000000009",
    toMonoNs: "18000000000000000012",
    partial: false,
    expectedCount: 0,
    validCount: 0,
    missingCount: 0,
    missingRate: null,
    metrics: null,
  });
  const partial = invoke({
    ...params,
    window: { ...params.window, length: "5", step: "4" },
  });
  assert.deepEqual(
    partial.windows.map(({ partial, expectedCount }) => [
      partial,
      expectedCount,
    ]),
    [
      [false, 2],
      [false, 2],
      [true, 1],
    ],
  );
});

test("the worker rejects duplicate or out-of-grid data, invalid numbers and unbounded window sizes", () => {
  const invoke = handler();
  assert.throws(
    () =>
      invoke({ ...series, samples: [...series.samples, series.samples[0]] }),
    /outside the grid or duplicated/,
  );
  assert.throws(
    () => invoke({ ...series, samples: [{ position: "1", value: 1 }] }),
    /outside the grid or duplicated/,
  );
  assert.throws(
    () =>
      invoke({
        ...series,
        samples: [{ position: series.firstPosition, value: Infinity }],
      }),
    /must be finite/,
  );
  assert.throws(
    () => invoke({ ...series, expectedSlots: 258 }),
    /more than 128 windows/,
  );
  assert.throws(
    () => invoke({ ...series, firstPosition: "18446744073709551614" }),
    /range exceeds u64/,
  );
  assert.throws(() => invoke(series, AbortSignal.abort()), {
    name: "AbortError",
  });
});
