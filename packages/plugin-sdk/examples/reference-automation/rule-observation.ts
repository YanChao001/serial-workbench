import type {
  SourceRange,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";
import { compileRuleCondition } from "./rule-condition.ts";
import type { Session } from "./session-transaction.ts";

type Event = StreamReadResult["events"][number];
type RuleSession = Pick<Session, "hostId" | "sessionId" | "sessionEpoch">;
type Observation =
  { kind: "match"; source: SourceRange } | { kind: "source_changed" };

export function endsRuleObservation(event: Event): boolean {
  return (
    event.kind === "gap" ||
    event.kind === "configuration_boundary" ||
    (event.kind === "lifecycle" && event.payload.state !== "open")
  );
}

export function watchRuleCondition(
  definition: unknown,
  session: RuleSession,
  startEventSeq: string,
  startAtBoundary: boolean,
) {
  const condition = compileRuleCondition(definition);
  const { framing } = condition;
  if (framing.kind === "fixed" && !startAtBoundary)
    throw new Error("Fixed frames require a confirmed starting boundary");
  const frame = Buffer.alloc(
    framing.kind === "line" ? framing.maxBytes : framing.byteLength,
  );
  let cursor = startEventSeq;
  let nextByte: bigint | undefined;
  let lastTime: Event["time"] | undefined;
  let retained = 0;
  let skipLine = !startAtBoundary;
  let start: { byte: bigint; event: string } | undefined;
  let finished = false;

  const stop = (): Observation => {
    finished = true;
    return { kind: "source_changed" };
  };

  return {
    get nextEventSeq() {
      return cursor;
    },
    observe(event: Event): Observation | undefined {
      if (finished) return;
      if (
        event.hostId !== session.hostId ||
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.eventSeq !== cursor ||
        endsRuleObservation(event)
      ) {
        return stop();
      }
      cursor = String(BigInt(cursor) + 1n);
      if (event.kind !== "rx") return;

      const { byteStart, byteEnd, bytesBase64 } = event.payload;
      const bytes = Buffer.from(bytesBase64, "base64");
      const offset = BigInt(byteStart);
      const end = BigInt(byteEnd);
      const observedTime = BigInt(event.time.sourceMonoNs);
      if (
        (nextByte !== undefined && offset !== nextByte) ||
        (lastTime !== undefined &&
          (lastTime.clockId !== event.time.clockId ||
            lastTime.precision.source !== event.time.precision.source ||
            lastTime.precision.resolutionNs !==
              event.time.precision.resolutionNs ||
            observedTime < BigInt(lastTime.sourceMonoNs))) ||
        bytes.length === 0 ||
        bytes.toString("base64") !== bytesBase64 ||
        end - offset !== BigInt(bytes.length)
      )
        return stop();
      nextByte = end;
      lastTime = event.time;

      for (let index = 0; index < bytes.length;) {
        let contentEnd: number;
        let afterFrame: number;
        let completesFrame: boolean;
        if (framing.kind === "line") {
          const lf = bytes.indexOf(10, index);
          completesFrame = lf !== -1;
          contentEnd = completesFrame ? lf : bytes.length;
          afterFrame = completesFrame ? contentEnd + 1 : bytes.length;
        } else {
          contentEnd = Math.min(bytes.length, index + frame.length - retained);
          completesFrame = retained + contentEnd - index === frame.length;
          afterFrame = contentEnd;
        }

        const pieceLength = contentEnd - index;
        if (retained + pieceLength > frame.length) skipLine = true;
        if (!skipLine) {
          start ??= { byte: offset + BigInt(index), event: event.eventSeq };
          bytes.copy(frame, retained, index, contentEnd);
          retained += pieceLength;
        }
        index = afterFrame;
        if (!completesFrame) break;

        if (
          start &&
          !skipLine &&
          condition.matches(frame.subarray(0, retained))
        ) {
          finished = true;
          return {
            kind: "match",
            source: {
              hostId: session.hostId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
              direction: "rx",
              eventStart: start.event,
              eventEnd: cursor,
              byteStart: String(start.byte),
              byteEnd: String(offset + BigInt(index)),
            },
          };
        }
        start = undefined;
        retained = 0;
        skipLine = false;
      }
    },
  };
}
