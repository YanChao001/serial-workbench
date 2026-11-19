import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeRegister,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";

const action = "swb.reference.chart.sample";
const maxFrameBytes = 64;
const maxIdleMs = 5000;
const voltage = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)\r?$/;

export const register: NodeRegister = (context) => {
  context.actions.register(action, async ({ target, params }, task) => {
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
          const receipt = await task.streams.publishDerived({
            sources: [source],
            value,
            unit: "V",
            quality: ["complete", "transformed"],
          });
          length = 0;
          sampled++;
          task.progress.report({
            completed: String(sampled),
            total: String(sampleCount),
            unit: "samples",
          });
          if (sampled === sampleCount)
            return { samples: sampled, lastPosition: receipt.position };
        }
      }
      nextEventSeq = page.nextEventSeq;
      if (performance.now() - idleSince >= maxIdleMs)
        throw new Error("Timed out waiting for chart samples");
      if (!page.hasMore) await delay(25, undefined, { signal: task.signal });
    }
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
