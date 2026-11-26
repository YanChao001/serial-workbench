import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-statistics/main.ts";
import manifest from "../packages/plugin-sdk/examples/reference-statistics/manifest.json" with { type: "json" };

function handler(actionId = "swb.reference.statistics.windows") {
  let installed;
  register({
    actions: {
      register(id, run) {
        assert.ok(
          manifest.contributes.actions.some((action) => action.actionId === id),
        );
        if (id === actionId) installed = run;
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
      { position: "10", value: "4.25" },
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
  const { inputSchema, outputSchema } = manifest.contributes.actions[0];
  const ajv = new Ajv();
  assert.ok(ajv.validate(inputSchema, params), JSON.stringify(ajv.errors));
  assert.ok(ajv.validate(outputSchema, report), JSON.stringify(ajv.errors));
  assert.equal(report.windows[0].metrics.average, 4.25);
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
    /must be a finite decimal string/,
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

const workbenchXY = () => handler("swb.reference.statistics.alignXY");

function seriesForXY(sourceId, clockId, samples) {
  return {
    sourceId,
    clockId,
    samples: samples.map(([time, value, gapBefore]) => ({
      monoNs: String(time),
      value: value === null ? null : String(value),
      ...(gapBefore ? { gapBefore } : {}),
    })),
  };
}

test("cross-source XY keeps nanosecond drift and the exact interpolation fraction auditable", () => {
  const start = 18000000000000000000n;
  const request = {
    x: seriesForXY("first", "capture-a", [
      [start, 1],
      [start + 1n, 2],
      [start + 2n, 3],
      [start + 3n, 4],
    ]),
    y: seriesForXY("second", "capture-b", [
      [100, 0],
      [101, 6],
      [102, 12],
    ]),
    method: "linear",
    maxGapNs: "2",
    anchors: [
      { xMonoNs: String(start), yMonoNs: "100" },
      { xMonoNs: String(start + 3n), yMonoNs: "102" },
    ],
  };
  const result = workbenchXY()(request);
  const { inputSchema, outputSchema } = manifest.contributes.actions.find(
    (action) => action.actionId === "swb.reference.statistics.alignXY",
  );
  const ajv = new Ajv();
  for (const [schema, value] of [
    [inputSchema, request],
    [outputSchema, result],
  ]) {
    const verify = ajv.compile(schema);
    assert.ok(verify(value), JSON.stringify(verify.errors));
  }
  assert.deepEqual(result.clockRate, { numerator: "3", denominator: "2" });
  assert.deepEqual(result.anchors, request.anchors);
  assert.deepEqual(result.pairs[0], {
    x: { index: 0, monoNs: String(start), value: "1" },
    y: { status: "exact", sample: { index: 0, monoNs: "100", value: "0" } },
    breakBefore: false,
  });
  assert.deepEqual(result.pairs[1].y, {
    status: "interpolated",
    before: { index: 0, monoNs: "100", value: "0" },
    after: { index: 1, monoNs: "101", value: "6" },
    value: "4",
    fraction: { numerator: "2", denominator: "3" },
  });
  assert.equal(result.pairs[2].y.value, "8");
  assert.equal(result.pairs[3].y.sample.value, "12");
  assert.ok(result.pairs.every((point) => !point.breakBefore));
});

test("one paired anchor aligns phase-shifted sine and cosine channels into a closed Lissajous circle", () => {
  const scale = 100;
  const start = 1000;
  const phases = [0, 1, 2, 3, 4];
  const request = {
    x: seriesForXY(
      "horizontal",
      "clock-a",
      phases.map((p) => [p * scale, Math.sin((p * Math.PI) / 2)]),
    ),
    y: seriesForXY(
      "vertical",
      "clock-b",
      phases.map((p) => [start + p * scale, Math.cos((p * Math.PI) / 2)]),
    ),
    method: "exact",
    maxGapNs: String(scale),
    anchors: [{ xMonoNs: "0", yMonoNs: String(start) }],
  };
  const axes = workbenchXY()(request).pairs.map(({ x, y, breakBefore }) => {
    assert.equal(y.status, "exact");
    assert.equal(breakBefore, false);
    const point = [Number(x.value), Number(y.sample.value)];
    assert.ok(Math.abs(Math.hypot(...point) - 1) < 1e-12);
    return point.map((value) => (Math.abs(value) < 1e-12 ? 0 : value));
  });
  assert.deepEqual(axes, [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
    [0, 1],
  ]);
});

test("XY skips unknown and declared gaps, preserves line breaks, and never extrapolates", () => {
  const times = [0, 1, 2, 3, 5, 7, 9, 10, 12, 15, 16, 17, 19];
  const request = {
    x: seriesForXY(
      "x",
      "shared",
      times.map((t) => [t, t === 9 ? null : 1, t === 17]),
    ),
    y: seriesForXY("y", "shared", [
      [1, -Number.MAX_VALUE],
      [3, Number.MAX_VALUE],
      [7, 2, true],
      [10, null],
      [15, 3],
      [16, 4],
      [17, 5],
    ]),
    method: "linear",
    maxGapNs: "3",
  };
  const result = workbenchXY()(request);
  assert.deepEqual(
    result.pairs.map(({ y }) => y.reason ?? y.status),
    [
      "outside",
      "exact",
      "interpolated",
      "exact",
      "gap",
      "exact",
      "x_missing",
      "y_missing",
      "gap",
      "exact",
      "exact",
      "exact",
      "outside",
    ],
  );
  assert.equal(result.pairs[2].y.value, "0");
  assert.equal(result.pairs[5].breakBefore, true);
  assert.equal(result.pairs[10].breakBefore, false);
  assert.equal(result.pairs[11].breakBefore, true);
  const exactAcrossGap = workbenchXY()({
    ...request,
    x: seriesForXY("x", "shared", [
      [3, 1],
      [7, 1],
    ]),
  });
  assert.deepEqual(
    exactAcrossGap.pairs.map((point) => point.breakBefore),
    [false, true],
  );
  assert.equal(
    workbenchXY()({ ...request, method: "exact" }).pairs[2].y.reason,
    "no_exact_match",
  );
});

test("XY enforces clock evidence, source order, bounded input, and cancellation", () => {
  const x = seriesForXY("x", "first", [
    [0, 0],
    [1, 1],
  ]);
  const y = seriesForXY("y", "second", [
    [2, 2],
    [3, 3],
  ]);
  const request = { x, y, method: "linear", maxGapNs: "1" };
  const run = workbenchXY();
  assert.throws(() => run(request), /distinct clocks require/);
  const anchors = [{ xMonoNs: "0", yMonoNs: "2" }];
  const input = { ...request, anchors };
  assert.throws(
    () => run({ ...input, y: { ...y, clockId: "first" } }),
    /shared clock/,
  );
  assert.throws(
    () =>
      run({ ...input, anchors: [...anchors, { xMonoNs: "1", yMonoNs: "1" }] }),
    /advance/,
  );
  assert.throws(
    () =>
      run({
        ...input,
        x: seriesForXY("x", "first", [
          [2, 0],
          [1, 1],
        ]),
      }),
    /must not go backwards/,
  );
  assert.throws(
    () => run({ ...input, x: seriesForXY("x", "first", [[1, "1e999"]]) }),
    /finite decimal/,
  );
  assert.throws(
    () => run({ ...input, maxGapNs: "18446744073709551616" }),
    /unsigned 64-bit/,
  );
  assert.throws(
    () =>
      run({ ...input, y: { ...y, samples: Array(129).fill(y.samples[0]) } }),
    /at most 128/,
  );
  assert.throws(
    () => run(input, AbortSignal.abort("cancelled")),
    (error) => error === "cancelled",
  );
});

const spectrumAction = "swb.reference.statistics.spectrum";
const firstSpectrumPosition = 9007199254740993n;

function spectrumRequest(
  samples,
  expectedSlots = samples.length,
  overrides = {},
) {
  return {
    clockId: "spectrum-source",
    unit: "V",
    firstPosition: String(firstSpectrumPosition),
    expectedSlots,
    periodNs: "1000000",
    samples: samples.flatMap((value, i) =>
      value === null
        ? []
        : [
            {
              position: String(firstSpectrumPosition + BigInt(i)),
              value: String(value),
            },
          ],
    ),
    window: {
      size: 8,
      hop: 8,
      shape: "rectangular",
      detrend: "none",
      missing: "skip",
    },
    histogram: { bins: 4 },
    ...overrides,
  };
}

test("spectrum labels a coherent sine, does not double DC or Nyquist, and reports exact window offsets", () => {
  const size = 32;
  const wave = Array.from(
    { length: size },
    (_, i) => 3 + 2 * Math.sin((2 * Math.PI * i * 3) / size) + 0.5 * (-1) ** i,
  );
  const request = spectrumRequest(wave, size, {
    window: {
      size,
      hop: size,
      shape: "rectangular",
      detrend: "none",
      missing: "skip",
    },
  });
  const run = handler(spectrumAction);
  const result = run(request);
  const spec = manifest.contributes.actions.find(
    ({ actionId }) => actionId === spectrumAction,
  );
  const ajv = new Ajv();
  const verifyInput = ajv.compile(spec.inputSchema);
  const verifyOutput = ajv.compile(spec.outputSchema);
  assert.ok(verifyInput(request), JSON.stringify(verifyInput.errors));
  assert.ok(verifyOutput(result), JSON.stringify(verifyOutput.errors));
  assert.equal(result.sampleRateHz, 1000);
  assert.equal(result.frequenciesHz[3], 93.75);
  assert.equal(result.frequenciesHz.at(-1), 500);
  const [row] = result.windows;
  assert.equal(row.fromPosition, "9007199254740993");
  assert.equal(row.toPosition, "9007199254741025");
  assert.equal(row.fromOffsetNs, "0");
  assert.equal(row.toOffsetNs, "32000000");
  assert.equal(row.peakBin, 0);
  const expected = new Map([
    [0, 3],
    [3, 2],
    [16, 0.5],
  ]);
  for (const [bin, amplitude] of expected)
    assert.ok(
      Math.abs(row.amplitudeDb[bin] - 20 * Math.log10(amplitude)) < 1e-10,
    );
  const detrended = run({
    ...request,
    window: { ...request.window, detrend: "mean" },
  }).windows[0];
  assert.equal(detrended.peakBin, 3);
  assert.ok(
    detrended.amplitudeDb[0] === null || detrended.amplitudeDb[0] < -250,
  );
});

test("periodic Hann normalization and waterfall row order agree with a direct DFT", () => {
  const N = 16;
  const wave = Array.from(
    { length: N },
    (_, i) => 1.25 * Math.cos((Math.PI * i) / 4) + 0.125 * (i % 3),
  );
  const request = spectrumRequest(
    [...wave, ...wave.map((sample) => sample * 2)],
    N * 2,
    {
      window: {
        size: N,
        hop: N,
        shape: "hann",
        detrend: "none",
        missing: "skip",
      },
    },
  );
  const { windows } = handler(spectrumAction)(request);
  assert.deepEqual(
    windows.map((row) => row.fromOffsetNs),
    ["0", "16000000"],
  );
  assert.deepEqual(
    windows.map((row) => row.peakBin),
    [2, 2],
  );
  for (const [bin, amplitudeDb] of windows[0].amplitudeDb.entries()) {
    let real = 0;
    let imag = 0;
    for (let i = 0; i < N; i++) {
      const sample = wave[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
      const angle = (-2 * Math.PI * bin * i) / N;
      real += sample * Math.cos(angle);
      imag += sample * Math.sin(angle);
    }
    const factor = bin > 0 && bin < N / 2 ? 2 : 1;
    const direct = 20 * Math.log10((factor * Math.hypot(real, imag)) / (N / 2));
    assert.ok(Math.abs(amplitudeDb - direct) < 1e-9);
    assert.ok(
      Math.abs(windows[1].amplitudeDb[bin] - amplitudeDb - 20 * Math.log10(2)) <
        1e-9,
    );
  }
});

test("waterfall retains skipped and empty rows, and zero fill never enters histogram counts", () => {
  const values = [1, 1, 1, null, 1, 1, 1, 1, ...Array(8).fill(null), 4, 8];
  const request = spectrumRequest(values, values.length, {
    histogram: { bins: 2, domain: { min: "0", max: "4" } },
  });
  const run = handler(spectrumAction);
  const skipped = run(request);
  const filled = run({
    ...request,
    window: { ...request.window, missing: "zero" },
  });
  assert.equal(skipped.uncoveredTailSlots, 2);
  assert.equal(skipped.validCount, 9);
  assert.equal(skipped.missingCount, 9);
  assert.deepEqual(
    skipped.windows.map((row) => [
      row.status,
      row.missingCount,
      row.amplitudeDb,
    ]),
    [
      ["skipped", 1, null],
      ["empty", 8, null],
    ],
  );
  assert.equal(filled.windows[0].status, "zero_filled");
  assert.equal(filled.windows[0].amplitudeDb.length, 5);
  assert.equal(filled.windows[1].amplitudeDb, null);
  assert.deepEqual(filled.histogram, skipped.histogram);
  assert.deepEqual(filled.histogram.bins, [
    { from: 0, to: 2, count: 7 },
    { from: 2, to: 4, count: 1 },
  ]);
  assert.equal(filled.histogram.above, 1);
});

test("large and constant histogram domains, sparse input, and window budgets are explicit", () => {
  const run = handler(spectrumAction);
  const maximum = Number.MAX_VALUE;
  const extremes = run(spectrumRequest([-maximum, 0, maximum]));
  assert.equal(extremes.windows.length, 0);
  assert.deepEqual(
    extremes.histogram.bins.map(({ count }) => count),
    [1, 0, 1, 1],
  );
  assert.ok(
    extremes.histogram.bins.every(
      ({ from, to }) => Number.isFinite(from) && Number.isFinite(to),
    ),
  );
  assert.deepEqual(run(spectrumRequest([5, 5, 5])).histogram.bins, [
    { from: 5, to: 5, count: 3 },
  ]);
  const input = spectrumRequest(Array(8).fill(0));
  assert.deepEqual(run(input).windows[0].amplitudeDb, Array(5).fill(null));
  assert.equal(run(input).windows[0].peakBin, null);
  assert.throws(
    () => run({ ...input, expectedSlots: 270 }),
    /more than 32 windows/,
  );
  assert.throws(
    () =>
      run({
        ...input,
        samples: [...input.samples.slice(0, 7), input.samples[0]],
      }),
    /duplicated/,
  );
  assert.throws(
    () => run({ ...input, periodNs: "18446744073709551615" }),
    /grid exceeds u64/,
  );
  assert.throws(
    () => run({ ...input, window: { ...input.window, size: 10 } }),
    /power of two/,
  );
  assert.throws(
    () =>
      run({ ...input, histogram: { bins: 3, domain: { min: "5", max: "5" } } }),
    /below max/,
  );
  assert.throws(
    () => run(input, AbortSignal.abort("cancelled")),
    (error) => error === "cancelled",
  );
});

test("XY preserves simultaneous X points and refuses to choose or interpolate across simultaneous Y values", () => {
  const run = workbenchXY();
  const request = {
    x: seriesForXY("x", "shared", [
      [1, 4],
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
      [5, 9],
    ]),
    y: seriesForXY("y", "shared", [
      [1, 10],
      [3, 20],
      [3, 30],
      [5, 40],
    ]),
    method: "linear",
    maxGapNs: "10",
  };
  const { pairs } = run(request);
  assert.deepEqual(
    pairs.map(({ y }) => y.reason ?? y.status),
    [
      "exact",
      "exact",
      "ambiguous_y_time",
      "ambiguous_y_time",
      "ambiguous_y_time",
      "exact",
    ],
  );
  assert.deepEqual(pairs[3].y.before, { index: 1, monoNs: "3", value: "20" });
  assert.deepEqual(pairs[3].y.after, { index: 2, monoNs: "3", value: "30" });
  assert.equal(pairs[5].breakBefore, true);
});
