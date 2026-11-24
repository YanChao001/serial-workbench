import assert from "node:assert/strict";
import test from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { renderPng } from "../packages/plugin-sdk/examples/reference-chart/render-png.ts";
import { register } from "../packages/plugin-sdk/examples/reference-chart/main.ts";
import { sampleStatistics } from "../packages/plugin-sdk/examples/reference-chart/sample-statistics.ts";

test("chart statistics use known positions and finite, uncompressed values", () => {
  const result = sampleStatistics([4, 2, 1, 3], 5n);
  assert.equal(result.validCount, 4);
  assert.equal(result.missingCount, 1n);
  assert.equal(result.missingRate, 0.2);
  const { p95, p99, ...metrics } = result.metrics;
  assert.deepEqual(metrics, {
    minimum: 1,
    maximum: 4,
    average: 2.5,
    deviation: Math.sqrt(1.25),
    p50: 2.5,
  });
  assert.ok(Math.abs(p95 - 3.85) < 1e-14);
  assert.ok(Math.abs(p99 - 3.97) < 1e-14);
  assert.equal(sampleStatistics([], 0n).missingRate, undefined);
  assert.equal(sampleStatistics([], 2n).missingRate, 1);
  assert.equal(sampleStatistics([], 2n).metrics, undefined);
});

test("chart statistics remain finite at both ends of the numeric range", () => {
  const maximum = Number.MAX_VALUE;
  const large = sampleStatistics([-maximum, maximum], 2n).metrics;
  assert.equal(large.average, 0);
  assert.equal(large.deviation, maximum);
  assert.equal(large.p50, 0);
  assert.ok(Number.isFinite(large.p99));
  const small = Number.MIN_VALUE;
  assert.equal(sampleStatistics([-small, small], 2n).metrics.deviation, small);
});

test("the chart cannot join a partially read sample across a source gap", async () => {
  let sample;
  register({
    contributions: { register() {} },
    actions: { register() {} },
    parsers: {
      register: (_, handler) => {
        sample = handler;
      },
    },
  });
  const pages = [
    {
      events: [
        {
          kind: "rx",
          eventSeq: "1",
          payload: {
            byteStart: "0",
            byteEnd: "2",
            bytesBase64: Buffer.from("1.").toString("base64"),
          },
        },
      ],
      nextEventSeq: "2",
      hasMore: true,
    },
    {
      events: [{ kind: "gap", eventSeq: "2" }],
      nextEventSeq: "3",
      hasMore: true,
    },
  ];
  const readCursors = [];
  const published = [];
  await assert.rejects(
    sample(
      {
        target: {
          hostId: "host",
          sessionId: "virtual-echo",
          sessionEpoch: "1",
        },
        params: { startEventSeq: "1", sampleCount: 1 },
      },
      {
        signal: new AbortController().signal,
        streams: {
          read({ startEventSeq }) {
            readCursors.push(startEventSeq);
            return pages.shift();
          },
          publishDerived(value) {
            published.push(value);
          },
        },
      },
    ),
    /source boundary/,
  );
  assert.deepEqual(readCursors, ["1", "2"]);
  assert.deepEqual(published, []);
});

test("offscreen PNG shares SVG sample positions and produces a bounded decodable image", async () => {
  const actions = new Map();
  register({
    contributions: { register() {} },
    actions: { register: (id, handler) => actions.set(id, handler) },
    parsers: { register() {} },
  });
  const raw = Buffer.from("1.25\n-2\n3.5\n");
  const call = {
    target: { hostId: "host", sessionId: "port", sessionEpoch: "1" },
    params: { sampleCount: 3 },
  };
  const task = {
    signal: AbortSignal.timeout(2000),
    progress: { report() {} },
    streams: {
      read: async () => ({
        events: [
          {
            kind: "rx",
            eventSeq: "1",
            payload: {
              bytesBase64: raw.toString("base64"),
              byteStart: "0",
              byteEnd: String(raw.length),
            },
          },
        ],
      }),
    },
  };
  const svg = Buffer.from(
    await actions.get("swb.reference.chart.exportSvg")(call, task),
    "base64",
  ).toString("utf8");
  assert.match(svg, /points="72\.00,154\.25 344\.00,295\.64 616\.00,56\.36"/u);
  const encoded = Buffer.from(
    await actions.get("swb.reference.chart.exportPng")(call, task),
    "base64",
  );
  assert.deepEqual(encoded, renderPng([1.25, -2, 3.5]));
  assert.deepEqual(
    encoded.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const chunks = new Map();
  for (let offset = 8; offset < encoded.length;) {
    const length = encoded.readUInt32BE(offset);
    const end = offset + 8 + length;
    assert.ok(end + 4 <= encoded.length);
    const name = encoded.subarray(offset + 4, offset + 8).toString("ascii");
    assert.ok(!chunks.has(name));
    assert.equal(
      encoded.readUInt32BE(end),
      crc32(encoded.subarray(offset + 4, end)),
    );
    chunks.set(name, encoded.subarray(offset + 8, end));
    offset = end + 4;
  }
  assert.deepEqual(
    [...chunks.keys()],
    ["IHDR", "sRGB", "PLTE", "tEXt", "IDAT", "IEND"],
  );
  const header = chunks.get("IHDR");
  assert.equal(header.readUInt32BE(0), 640);
  assert.equal(header.readUInt32BE(4), 360);
  assert.deepEqual([...header.subarray(8)], [8, 3, 0, 0, 0]);
  const raster = inflateSync(chunks.get("IDAT"), {
    maxOutputLength: 641 * 360,
  });
  assert.equal(raster.length, 641 * 360);
  assert.ok(
    Array.from({ length: 360 }, (_, y) => raster[y * 641]).every(
      (filter) => filter === 0,
    ),
  );
  const pixel = (x, y) => raster[y * 641 + x + 1];
  assert.deepEqual(
    [
      [72, 154],
      [344, 296],
      [616, 56],
    ].map(([x, y]) => pixel(x, y)),
    [3, 3, 3],
  );
  assert.equal(pixel(500, 42), 1);
  assert.equal(pixel(72, 13), 2);
  assert.ok(
    renderPng(
      Array.from({ length: 128 }, (_, index) => (index % 2 ? -1e6 : 1e6)),
    ).length <= 65536,
  );
  assert.ok(renderPng([0.25]).length <= 65536);
});
