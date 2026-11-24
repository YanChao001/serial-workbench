import { setTimeout as delay } from "node:timers/promises";
import type {
  Call,
  NodeRegister,
  NodeTaskContext,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";

import { chartCanvas, chartGeometry } from "./chart-geometry.ts";
import { csvCell, spreadsheetText } from "./csv.ts";
import { renderPng } from "./render-png.ts";

const maxFrameBytes = 64;
const maxIdleMs = 5000;
const voltage = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)\r?$/;

async function readSamples(
  { target, params }: Readonly<Call>,
  task: NodeTaskContext,
  receive: (
    value: number,
    source: SourceRange,
    decimal: string,
  ) => void | Promise<void>,
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
        await receive(value, source, line.trimEnd().replace(/^\+/u, ""));
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
  const { width, height, left, right } = chartCanvas;
  const { coordinates, ticks } = chartGeometry(samples);
  const points = coordinates.map(({ x, y }) => ({
    x: x.toFixed(2),
    y: y.toFixed(2),
  }));
  const grid = ticks.map((tick) => {
    const row = tick.y.toFixed(2);
    return `<path d="M ${left} ${row} H ${right}" stroke="#d7dee7"/><text x="64" y="${row}" text-anchor="end" dominant-baseline="middle">${tick.label}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<title>Voltage by sample</title>",
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
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
    `<polyline points="${points.map(({ x, y }) => `${x},${y}`).join(" ")}" fill="none" stroke="#226350" stroke-width="2"/>`,
    ...points.map(
      ({ x, y }) => `<circle cx="${x}" cy="${y}" r="3" fill="#226350"/>`,
    ),
    "</svg>",
  ].join("\n");
}

export function chartRegistration(packageId: string): NodeRegister {
  const sample = `${packageId}.sample`;
  const exportSvg = `${packageId}.exportSvg`;
  const exportCsv = `${packageId}.exportCsv`;
  const exportPng = `${packageId}.exportPng`;
  return (context) => {
    context.parsers.register(sample, async (call, task) => {
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
    for (const [id, render] of [
      [exportSvg, (samples: number[]) => Buffer.from(renderSvg(samples))],
      [exportPng, renderPng],
    ] as const) {
      context.actions.register(id, async (call, task) => {
        const samples: number[] = [];
        await readSamples(call, task, (value) => {
          samples.push(value);
        });
        task.signal.throwIfAborted();
        return render(samples).toString("base64");
      });
    }
    context.actions.register(exportCsv, async (call, task) => {
      const rows = [
        "sample_index,value_v,host_id,session_id,session_epoch,event_start,event_end,byte_start,byte_end",
      ];
      await readSamples(call, task, (_value, source, decimal) => {
        rows.push(
          [
            String(rows.length),
            decimal,
            spreadsheetText(source.hostId),
            spreadsheetText(source.sessionId),
            source.sessionEpoch,
            source.eventStart,
            source.eventEnd,
            source.byteStart,
            source.byteEnd,
          ]
            .map(csvCell)
            .join(","),
        );
      });
      return Buffer.from(rows.join("\r\n") + "\r\n").toString("base64");
    });
    context.contributions.register({
      actions: [],
      queries: [],
      transports: [],
      parsers: [],
      views: [`${packageId}.view`],
      themes: [],
      configuration: [],
    });
    return () => {};
  };
}

export const register = chartRegistration("swb.reference.chart");
