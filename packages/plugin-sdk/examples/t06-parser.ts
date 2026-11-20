import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeRegister,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";

export const register: NodeRegister = (context) => {
  context.actions.register("example.t06.parse", async ({ target }, task) => {
    const { sessionId, sessionEpoch } = target;
    if (!sessionId || !sessionEpoch) throw new Error("T06 requires a session");
    const hash = createHash("sha256");
    let nextEvent = "1";
    let consumed = 0n;
    let position = "0";
    let range: SourceRange | undefined;
    const publish = async () => {
      if (!range?.byteStart || !range.byteEnd) return;
      const receipt = await task.streams.publishDerived({
        sources: [range],
        quality: ["complete", "transformed"],
        unit: "bytes",
        value: Number(BigInt(range.byteEnd) - BigInt(range.byteStart)),
      });
      position = receipt.position;
      range = undefined;
    };
    task.progress.report({ completed: "0", unit: "bytes" });
    while (true) {
      const page = await task.streams.read({
        sessionId,
        sessionEpoch,
        startEventSeq: nextEvent,
        maxEvents: "100",
        maxBytes: "65536",
      });
      for (const event of page.events) {
        task.signal.throwIfAborted();
        if (event.kind === "gap")
          throw new Error("T06 parser encountered a source gap");
        if (
          event.kind === "tx_intent" &&
          Buffer.from(event.payload.bytesBase64, "base64").equals(
            Buffer.from("SWB-T06-STOP"),
          )
        ) {
          await publish();
          task.progress.report({ completed: String(consumed), unit: "bytes" });
          return {
            bytes: String(consumed),
            sha256: hash.digest("hex"),
            published: position,
          };
        }
        if (event.kind !== "rx") continue;
        const { bytesBase64, byteStart, byteEnd } = event.payload;
        const bytes = Buffer.from(bytesBase64, "base64");
        if (
          BigInt(byteStart) !== consumed ||
          BigInt(byteEnd) - consumed !== BigInt(bytes.length)
        ) {
          throw new Error("T06 parser observed a byte discontinuity");
        }
        if (range && BigInt(event.eventSeq) - BigInt(range.eventStart) >= 100n)
          await publish();
        const eventEnd = String(BigInt(event.eventSeq) + 1n);
        range = range
          ? { ...range, eventEnd, byteEnd }
          : {
              hostId: event.hostId,
              sessionId,
              sessionEpoch,
              eventStart: event.eventSeq,
              eventEnd,
              direction: "rx",
              byteStart,
              byteEnd,
            };
        hash.update(bytes);
        consumed += BigInt(bytes.length);
        if (range.byteStart && consumed - BigInt(range.byteStart) >= 11_520n) {
          await publish();
          task.progress.report({ completed: String(consumed), unit: "bytes" });
        }
      }
      nextEvent = page.nextEventSeq;
      if (!page.hasMore) await delay(40, undefined, { signal: task.signal });
    }
  });
  return () => {};
};
