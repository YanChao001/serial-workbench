import { setTimeout as delay } from "node:timers/promises";
import type {
  Call,
  NodeRegister,
  NodeTaskContext,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";

const action = "swb.reference.chart.sample";
const exportSvg = "swb.reference.chart.exportSvg";
const maxFrameBytes = 64;
const maxIdleMs = 5000;
const voltage = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)\r?$/;

async function readSamples(
  { target, params }: Readonly<Call>,
  task: NodeTaskContext,
  receive: (value: number, source: SourceRange) => void | Promise<void>,
) {
  const { hostId, sessionId, sessionEpoch } = target;
  const { startEventSeq = "1", sampleCount = 3 } = params;
  if (
    !sessionId ||
    !sessionEpoch ||
    typeof startEventSeq !== "string" ||
    typeof sampleCount !== "number" ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > 128
  ) {
    throw new Error(
      "Chart sampling requires an exact session, event cursor and bounded count",
    );
  }
  const frame = Buffer.alloc(maxFrameBytes);
  let length = 0;
  let nextEventSeq = startEventSeq;
  let nextByte: bigint | undefined;
  let frameStart = 0n;
  let frameEvent = 0n;
  let sampled = 0;
  let idleSince = performance.now();
  while (true) {
    task.signal.throwIfAborted();
    const page = await task.streams.read({
      sessionId,
      sessionEpoch,
      startEventSeq: nextEventSeq,
      maxEvents: "100",
      maxBytes: "65536",
    });
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.kind === "gap" ||
        (event.kind === "configuration_boundary" && length > 0)
      ) {
        throw new Error("Chart input crossed a source boundary");
      }
      if (event.kind !== "rx") continue;
      const { bytesBase64, byteStart, byteEnd } = event.payload;
      const bytes = Buffer.from(bytesBase64, "base64");
      const start = BigInt(byteStart);
      const sequence = BigInt(event.eventSeq);
      if (
        (nextByte !== undefined && nextByte !== start) ||
        BigInt(byteEnd) !== start + BigInt(bytes.length)
      ) {
        throw new Error("Chart input has a discontinuous byte range");
      }
      nextByte = BigInt(byteEnd);
      idleSince = performance.now();
      for (const [index, byte] of bytes.entries()) {
        if (length === 0) {
          frameStart = start + BigInt(index);
          frameEvent = sequence;
        }
        if (byte !== 10) {
          if (length === frame.length)
            throw new Error("Chart sample exceeds 64 bytes");
          frame[length++] = byte;
          continue;
        }
        const line = frame.toString("latin1", 0, length);
        const value = Number(line);
        if (
          !voltage.test(line) ||
          !Number.isFinite(value) ||
          Math.abs(value) > 1_000_000 ||
          sequence - frameEvent >= 100n
        ) {
          throw new Error("Invalid chart voltage or source span");
        }
        const source: SourceRange = {
          hostId,
          sessionId,
          sessionEpoch,
          direction: "rx",
          eventStart: String(frameEvent),
          eventEnd: String(sequence + 1n),
          byteStart: String(frameStart),
          byteEnd: String(start + BigInt(index) + 1n),
        };
        await receive(value, source);
        length = 0;
        sampled++;
        task.progress.report({
          completed: String(sampled),
          total: String(sampleCount),
          unit: "samples",
        });
        if (sampled === sampleCount) return sampled;
      }
    }
    nextEventSeq = page.nextEventSeq;
    if (performance.now() - idleSince >= maxIdleMs)
      throw new Error("Timed out waiting for chart samples");
    if (!page.hasMore) await delay(25, undefined, { signal: task.signal });
  }
}

function renderSvg(samples: number[]) {
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const padding = (high - low) * 0.06 || 0.5;
  const min = low - padding;
  const max = high + padding;
  const left = 72;
  const right = 616;
  const top = 42;
  const bottom = 310;
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const coordinates = samples.map((value, index) => ({
    x: (
      left +
      (index * (right - left)) / Math.max(samples.length - 1, 1)
    ).toFixed(2),
    y: y(value).toFixed(2),
  }));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = min + (index * (max - min)) / 4;
    const row = y(value).toFixed(2);
    return `<path d="M ${left} ${row} H ${right}" stroke="#d7dee7"/><text x="64" y="${row}" text-anchor="end" dominant-baseline="middle">${Number(value.toPrecision(5))}</text>`;
  });
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
    "<title>Voltage by sample</title>",
    '<rect width="640" height="360" fill="#fff"/>',
    '<g font-family="sans-serif" font-size="12" fill="#394454">',
    `<text x="${left}" y="24">Voltage (V)</text>`,
    ...grid,
    `<text x="${left}" y="338">Sample 1</text>`,
    ...(samples.length > 1
      ? [
          `<text x="${right}" y="338" text-anchor="end">${samples.length}</text>`,
        ]
      : []),
    "</g>",
    `<polyline points="${coordinates.map(({ x, y }) => `${x},${y}`).join(" ")}" fill="none" stroke="#226350" stroke-width="2"/>`,
    ...coordinates.map(
      ({ x, y }) => `<circle cx="${x}" cy="${y}" r="3" fill="#226350"/>`,
    ),
    "</svg>",
  ].join("\n");
}

export const register: NodeRegister = (context) => {
  context.parsers.register(action, async (call, task) => {
    let lastPosition = "0";
    const samples = await readSamples(call, task, async (value, source) => {
      const receipt = await task.streams.publishDerived({
        sources: [source],
        value,
        unit: "V",
        quality: ["complete", "transformed"],
      });
      lastPosition = receipt.position;
    });
    return { samples, lastPosition };
  });
  context.actions.register(exportSvg, async (call, task) => {
    const samples: number[] = [];
    await readSamples(call, task, (value) => {
      samples.push(value);
    });
    return Buffer.from(renderSvg(samples)).toString("base64");
  });
  context.contributions.register({
    actions: [],
    queries: [],
    transports: [],
    parsers: [],
    views: ["swb.reference.chart.view"],
    themes: [],
    configuration: [],
  });
  return () => {};
};
