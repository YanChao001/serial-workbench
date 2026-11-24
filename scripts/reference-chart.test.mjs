import assert from "node:assert/strict";
import test from "node:test";
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
