import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-framing/main.ts";
import { scanMarkedFixedFrames } from "../src/features/workbench/live-fixed-framing.ts";

function rx(eventSeq, byteStart, bytes) {
  return {
    kind: "rx",
    hostId: "source-host",
    instanceEpoch: "1",
    sessionId: "virtual-echo",
    sessionEpoch: "2",
    configurationRevision: "4",
    eventSeq: String(eventSeq),
    payload: {
      byteStart: String(byteStart),
      byteEnd: String(byteStart + bytes.length),
      bytesBase64: Buffer.from(bytes).toString("base64"),
    },
  };
}

const target = {
  hostId: "source-host",
  sessionId: "virtual-echo",
  sessionEpoch: "2",
};
const source = { ...target, direction: "rx" };

function scanPages(pages, options) {
  const handlers = new Map();
  register({
    parsers: { register: (id, handler) => handlers.set(id, handler) },
  });
  const scan = handlers.get("swb.reference.framing.scan");
  assert.equal(typeof scan, "function");
  const cursors = [];
  const result = scan(
    {
      target,
      params: { startEventSeq: "10", endEventSeq: "13", ...options },
    },
    {
      signal: new AbortController().signal,
      streams: {
        async read({ sessionId, sessionEpoch, startEventSeq, maxBytes }) {
          assert.equal(sessionId, target.sessionId);
          assert.equal(sessionEpoch, target.sessionEpoch);
          cursors.push(startEventSeq);
          const page = pages.get(startEventSeq);
          assert.ok(page, `Unexpected page at ${startEventSeq}`);
          assert.ok(
            Buffer.byteLength(JSON.stringify(page)) <= Number(maxBytes),
            "The Raw read page must fit its encoded transport budget",
          );
          return page;
        },
      },
    },
  );
  return { result, cursors };
}

test("incremental fixed framing agrees with the Host scan on marked and escaped bytes", async () => {
  const cases = [
    {
      width: 2,
      header: [0xaa],
      chunks: [
        [0xff, 0xaa],
        [0x10, 0x00, 0xaa, 0x20],
      ],
    },
    {
      width: 3,
      header: [0xaa],
      footer: [0xcc],
      escape: 0x7d,
      chunks: [
        [0, 0x7d],
        [0xaa, 0, 0xcc, 0, 0xaa],
        [0x20, 0xcc, 0xaa, 0x7d, 0xcc],
      ],
    },
    {
      width: 3,
      header: [0xaa],
      footer: [0xcc],
      escape: 0x7d,
      chunks: [[0, 0x7d], [0x7d, 0xaa, 0x20], [0xcc]],
    },
    {
      width: 4,
      header: [0xaa, 0xbb],
      footer: [0xcc],
      chunks: [[0, 0xaa], [0xbb, 5], [0xcc]],
    },
    {
      width: 3,
      footer: [0xcc],
      escape: 0x7d,
      chunks: [[0xaa, 0x7d], [0xcc, 0x20], [0xcc]],
    },
  ];
  for (const example of cases) {
    const { width, header, footer, escape, chunks } = example;
    let offset = 0;
    const events = chunks.map((chunk, i) => {
      const event = rx(10 + i, offset, chunk);
      offset += chunk.length;
      return event;
    });
    const host = await scanPages(
      new Map([["10", { events, nextEventSeq: "13", hasMore: false }]]),
      {
        fixedLength: width,
        ...(header && { headerBase64: Buffer.from(header).toString("base64") }),
        ...(footer && { footerBase64: Buffer.from(footer).toString("base64") }),
        ...(escape !== undefined && { escapeByte: escape }),
      },
    ).result;
    let pending = Buffer.alloc(0);
    let accepted;
    let consumed = 0;
    let escapedBefore = false;
    for (const chunk of chunks) {
      const bytes = Buffer.concat([pending, Buffer.from(chunk)]);
      const result = scanMarkedFixedFrames(
        bytes,
        {
          width,
          header: header && Uint8Array.from(header),
          footer: footer && Uint8Array.from(footer),
          escape,
        },
        escapedBefore,
      );
      if (result.latest) {
        accepted = {
          bytesBase64: bytes.toString(
            "base64",
            result.latest.start,
            result.latest.end,
          ),
          byteStart: String(consumed + result.latest.start),
          byteEnd: String(consumed + result.latest.end),
        };
      }
      pending = bytes.subarray(result.pendingFrom);
      consumed += result.pendingFrom;
      escapedBefore = result.escapedBefore;
    }
    const latest = host.frames.at(-1);
    assert.ok(latest, "The reference must contain a complete frame");
    assert.deepEqual(accepted, {
      bytesBase64: latest.bytesBase64,
      byteStart: latest.source.byteStart,
      byteEnd: latest.source.byteEnd,
    });
  }
});

test("fixed-length scans preserve exact raw bytes and locations across paged RX", async () => {
  const pages = new Map([
    ["10", { events: [rx(10, 41, [1])], nextEventSeq: "11", hasMore: true }],
    [
      "11",
      {
        events: [rx(11, 42, [2, 3, 4, 5]), rx(12, 46, [6, 7])],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result, cursors } = scanPages(pages, { fixedLength: 3 });
  const output = await result;

  assert.deepEqual(cursors, ["10", "11"]);
  assert.deepEqual(output, {
    frames: [
      {
        bytesBase64: "AQID",
        source: {
          ...source,
          eventStart: "10",
          eventEnd: "12",
          byteStart: "41",
          byteEnd: "44",
        },
      },
      {
        bytesBase64: "BAUG",
        source: {
          ...source,
          eventStart: "11",
          eventEnd: "13",
          byteStart: "44",
          byteEnd: "47",
        },
      },
    ],
    incompleteBytes: 1,
  });
});

test("an escaped delimiter across reads does not split the frame and a long frame resynchronizes", async () => {
  const pages = new Map([
    [
      "10",
      { events: [rx(10, 41, [97, 98, 92])], nextEventSeq: "11", hasMore: true },
    ],
    [
      "11",
      {
        events: [
          rx(11, 44, [124, 99, 124, 120, 120, 120]),
          rx(12, 50, [120, 120, 120, 124, 111, 107, 124, 33]),
        ],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    delimiterBase64: "fA==",
    escapeByte: 92,
    maxFrameLength: 6,
  });

  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "YWJcfGN8",
        source: {
          ...source,
          eventStart: "10",
          eventEnd: "12",
          byteStart: "41",
          byteEnd: "47",
        },
      },
      {
        bytesBase64: "b2t8",
        source: {
          ...source,
          eventStart: "12",
          eventEnd: "13",
          byteStart: "54",
          byteEnd: "57",
        },
      },
    ],
    incompleteBytes: 8,
  });
});

test("frames never join bytes across a recorded RX gap", async () => {
  const first = rx(10, 41, [1, 2]);
  const gap = { ...first, kind: "gap", eventSeq: "11", payload: {} };
  const pages = new Map([
    [
      "10",
      {
        events: [first, gap, rx(12, 51, [3, 4, 5])],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, { fixedLength: 3 });

  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "AwQF",
        source: {
          ...source,
          eventStart: "12",
          eventEnd: "13",
          byteStart: "51",
          byteEnd: "54",
        },
      },
    ],
    incompleteBytes: 2,
  });
});

test("header alignment and a length field recover after an oversized declaration", async () => {
  const pages = new Map([
    [
      "10",
      { events: [rx(10, 41, [0, 0xa5])], nextEventSeq: "11", hasMore: true },
    ],
    [
      "11",
      {
        events: [
          rx(11, 43, [0xa5, 0x5a, 250, 0xa5, 0x5a, 2, 0x10]),
          rx(12, 50, [0xef, 0x0d, 0xa5, 0x5a, 1, 0x44, 0x0d]),
        ],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    headerBase64: "pVo=",
    footerBase64: "DQ==",
    lengthField: { offset: 2, width: 1, byteOrder: "be", adjustment: 4 },
    maxFrameLength: 32,
  });

  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "pVoCEO8N",
        source: {
          ...source,
          eventStart: "11",
          eventEnd: "13",
          byteStart: "46",
          byteEnd: "52",
        },
      },
      {
        bytesBase64: "pVoBRA0=",
        source: {
          ...source,
          eventStart: "12",
          eventEnd: "13",
          byteStart: "52",
          byteEnd: "57",
        },
      },
    ],
    incompleteBytes: 5,
  });
});

test("silence ends a frame only when the same source clock measures the gap", async () => {
  function timed(eventSeq, byteStart, bytes, clockId, sourceMonoNs) {
    return {
      ...rx(eventSeq, byteStart, bytes),
      time: {
        clockId,
        sourceMonoNs: String(sourceMonoNs),
        precision: { source: "host_read", resolutionNs: "1000" },
      },
    };
  }
  const pages = new Map([
    [
      "10",
      {
        events: [
          timed(10, 41, [1, 2], "clock-a", 1_000_000),
          timed(11, 43, [3], "clock-a", 2_000_000),
        ],
        nextEventSeq: "12",
        hasMore: true,
      },
    ],
    [
      "12",
      {
        events: [
          timed(12, 44, [4], "clock-a", 12_000_000),
          timed(13, 45, [5], "clock-b", 35_000_000),
          timed(14, 46, [6], "clock-b", 42_000_000),
        ],
        nextEventSeq: "15",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    endEventSeq: "15",
    idleTimeoutMs: 10,
  });

  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "AQID",
        source: {
          ...source,
          eventStart: "10",
          eventEnd: "12",
          byteStart: "41",
          byteEnd: "44",
        },
      },
    ],
    incompleteBytes: 3,
  });
});

test("an overlong header-to-footer frame can recover at a new header before the footer", async () => {
  const pages = new Map([
    [
      "10",
      {
        events: [
          rx(10, 41, Buffer.from(":01234")),
          rx(11, 47, Buffer.from("56789:")),
          rx(12, 53, Buffer.from("ok\r\n")),
        ],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    headerBase64: "Og==",
    footerBase64: "DQo=",
    maxFrameLength: 8,
  });

  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "Om9rDQo=",
        source: {
          ...source,
          eventStart: "11",
          eventEnd: "13",
          byteStart: "52",
          byteEnd: "57",
        },
      },
    ],
    incompleteBytes: 11,
  });
});

test("a missing tail does not hide a later valid frame in the same snapshot", async () => {
  const pages = new Map([
    [
      "10",
      {
        events: [rx(10, 41, [0xa5, 0x5a, 20, 0, 0xa5, 0x5a, 1, 0x44, 0x0d])],
        nextEventSeq: "11",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    endEventSeq: "11",
    headerBase64: "pVo=",
    footerBase64: "DQ==",
    lengthField: { offset: 2, width: 1, byteOrder: "be", adjustment: 4 },
    maxFrameLength: 32,
  });
  assert.deepEqual(await result, {
    frames: [
      {
        bytesBase64: "pVoBRA0=",
        source: {
          ...source,
          eventStart: "10",
          eventEnd: "11",
          byteStart: "45",
          byteEnd: "50",
        },
      },
    ],
    incompleteBytes: 4,
  });
});

test("a footer closes each frame when silence is also configured", async () => {
  function timed(eventSeq, byteStart, text, sourceMonoNs) {
    return {
      ...rx(eventSeq, byteStart, Buffer.from(text)),
      time: {
        clockId: "source",
        sourceMonoNs,
        precision: { source: "host_read", resolutionNs: "1000" },
      },
    };
  }
  const pages = new Map([
    [
      "10",
      {
        events: [
          timed(10, 41, ":A\r:B\r", "1000000"),
          timed(11, 47, ":C\r", "12000000"),
        ],
        nextEventSeq: "12",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, {
    endEventSeq: "12",
    headerBase64: "Og==",
    footerBase64: "DQ==",
    idleTimeoutMs: 10,
  });
  const output = await result;
  assert.equal(output.incompleteBytes, 0);
  assert.deepEqual(
    output.frames.map(({ bytesBase64 }) => bytesBase64),
    ["OkEN", "OkIN", "OkMN"],
  );
});

test("a large TX record does not consume the framing RX byte budget", async () => {
  const tx = {
    ...rx(11, 0, Buffer.alloc(128 * 1024)),
    kind: "tx_intent",
  };
  const pages = new Map([
    [
      "10",
      {
        events: [rx(10, 41, [1]), tx, rx(12, 42, [2, 3])],
        nextEventSeq: "13",
        hasMore: false,
      },
    ],
  ]);
  const { result } = scanPages(pages, { fixedLength: 3 });
  const output = await result;
  assert.equal(output.incompleteBytes, 0);
  assert.deepEqual(
    output.frames.map((frame) => frame.bytesBase64),
    ["AQID"],
  );
});

test("the frame limit leaves an exact resume cursor inside a Raw event", async () => {
  const pages = new Map([
    [
      "10",
      {
        events: [
          rx(
            10,
            41,
            Buffer.from(Array.from({ length: 130 }, (_, byte) => byte)),
          ),
        ],
        nextEventSeq: "11",
        hasMore: false,
      },
    ],
  ]);
  const first = await scanPages(pages, {
    endEventSeq: "11",
    fixedLength: 1,
  }).result;
  assert.equal(first.frames.length, 128);
  assert.equal(first.incompleteBytes, 0);
  assert.deepEqual(first.nextCursor, { eventSeq: "10", byteStart: "169" });
  assert.equal(first.frames.at(-1).source.byteEnd, "169");

  const next = await scanPages(pages, {
    startEventSeq: first.nextCursor.eventSeq,
    startByte: first.nextCursor.byteStart,
    endEventSeq: "11",
    fixedLength: 1,
  }).result;
  assert.deepEqual(
    next.frames.map((frame) => frame.bytesBase64),
    ["gA==", "gQ=="],
  );
  assert.equal(next.frames[0].source.byteStart, "169");
  assert.equal(next.incompleteBytes, 0);
  assert.equal(next.nextCursor, undefined);
});
