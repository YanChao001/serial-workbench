import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-chart/main.ts";

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
