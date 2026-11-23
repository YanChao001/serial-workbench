import type {
  Call,
  NodeActionHandler,
  NodeRegister,
  SourceRange,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";

const sequence = /^[1-9][0-9]{0,19}$/;
const byteOffset = /^(0|[1-9][0-9]{0,19})$/;
const maxSequence = (1n << 64n) - 1n;
const maxEvents = 1024n;
const maxInputBytes = 65_536;
const rawPageBytes = 256 * 1024;
const maxFrameBytes = 4096;
const maxFrames = 128;

function integerBetween(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function marker(value: unknown): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 24) {
    throw new Error("Invalid framing marker");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > 16 ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("Invalid framing marker");
  }
  return bytes;
}

function parseLengthField(value: unknown, limit: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid framing length field");
  }
  const field = value as Record<string, unknown>;
  const { offset, width, byteOrder, adjustment } = field;
  if (
    !integerBetween(offset, 0, limit - 1) ||
    (width !== 1 && width !== 2 && width !== 4) ||
    offset + width > limit ||
    (byteOrder !== "be" && byteOrder !== "le") ||
    !integerBetween(adjustment, -limit, limit)
  ) {
    throw new Error("Invalid framing length field");
  }
  return { offset, width, byteOrder, adjustment };
}

function framingOptions(params: Call["params"]) {
  const { fixedLength, escapeByte, maxFrameLength, idleTimeoutMs } = params;
  const limit = maxFrameLength === undefined ? maxFrameBytes : maxFrameLength;
  if (
    !integerBetween(limit, 1, maxFrameBytes) ||
    (fixedLength !== undefined && !integerBetween(fixedLength, 1, limit)) ||
    (escapeByte !== undefined && !integerBetween(escapeByte, 0, 255)) ||
    (idleTimeoutMs !== undefined && !integerBetween(idleTimeoutMs, 1, 60_000))
  ) {
    throw new Error("Invalid framing byte limit, escape or idle timeout");
  }
  const idleNs =
    idleTimeoutMs === undefined
      ? undefined
      : BigInt(idleTimeoutMs) * 1_000_000n;
  const field = parseLengthField(params.lengthField, limit);
  const header = marker(params.headerBase64);
  const footer = marker(params.footerBase64);
  const delimiter =
    marker(params.delimiterBase64) ??
    (fixedLength === undefined && field === undefined ? footer : undefined);
  const boundaryCount =
    Number(fixedLength !== undefined) +
    Number(field !== undefined) +
    Number(delimiter !== undefined);
  if (
    boundaryCount > 1 ||
    (boundaryCount === 0 && idleNs === undefined) ||
    [header, footer, delimiter].some(
      (value) =>
        value &&
        (value.length > limit ||
          (escapeByte !== undefined && value.includes(escapeByte))),
    ) ||
    (fixedLength !== undefined &&
      fixedLength < (header?.length ?? 0) + (footer?.length ?? 0))
  ) {
    throw new Error("Invalid framing boundary combination");
  }
  return {
    limit,
    fixedLength,
    field,
    header,
    footer,
    delimiter,
    escapeByte,
    idleNs,
  };
}

function escapeRuns(bytes: Buffer, escapeByte: number | undefined) {
  if (escapeByte === undefined) return undefined;
  const lengths = new Uint32Array(bytes.length + 1);
  let run = 0;
  for (const [index, byte] of bytes.entries()) {
    run = byte === escapeByte ? run + 1 : 0;
    lengths[index + 1] = run;
  }
  return lengths;
}

function isEscaped(
  lengths: Uint32Array | undefined,
  start: number,
  at: number,
) {
  return Math.min(lengths?.[at] ?? 0, at - start) % 2 !== 0;
}

function nextMarker(
  bytes: Buffer,
  pattern: Buffer,
  from: number,
  escapes: Uint32Array | undefined,
) {
  let at = bytes.indexOf(pattern, from);
  while (at >= 0 && isEscaped(escapes, from, at)) {
    at = bytes.indexOf(pattern, at + 1);
  }
  return at;
}

type FramingOptions = ReturnType<typeof framingOptions>;
type RxTime = StreamReadResult["events"][number]["time"];

function sourceElapsed(previous: RxTime, current: RxTime) {
  const { source, resolutionNs } = previous.precision;
  if (
    current.clockId !== previous.clockId ||
    current.precision.source !== source ||
    current.precision.resolutionNs !== resolutionNs
  )
    return undefined;
  const elapsed = BigInt(current.sourceMonoNs) - BigInt(previous.sourceMonoNs);
  return elapsed >= 0n ? elapsed : undefined;
}

function scanSegment(
  bytes: Buffer,
  options: FramingOptions,
  quiet: boolean,
  emit: (start: number, end: number) => boolean,
) {
  const { limit, fixedLength, field, header, footer, delimiter, escapeByte } =
    options;
  const requiredFooter =
    delimiter && footer?.equals(delimiter) ? undefined : footer;
  const idleOnly = !delimiter && !field && fixedLength === undefined;
  if (idleOnly && !quiet) return bytes.length;
  const escapes = escapeRuns(bytes, escapeByte);
  let cursor = 0;
  let framedBytes = 0;
  let delimiterAt = -1;
  while (cursor < bytes.length) {
    const start = header ? nextMarker(bytes, header, cursor, escapes) : cursor;
    if (start < 0) break;
    const content = start + (header?.length ?? 0);
    let end: number;
    if (delimiter) {
      if (delimiterAt < content) {
        delimiterAt = nextMarker(bytes, delimiter, content, escapes);
      }
      if (delimiterAt < 0) break;
      end = delimiterAt + delimiter.length;
    } else if (field) {
      if (start + field.offset + field.width > bytes.length) break;
      const position = start + field.offset;
      const length =
        (field.byteOrder === "be"
          ? bytes.readUIntBE(position, field.width)
          : bytes.readUIntLE(position, field.width)) + field.adjustment;
      if (
        length <
          Math.max(content - start, field.offset + field.width) +
            (footer?.length ?? 0) ||
        length > limit
      ) {
        cursor = start + 1;
        continue;
      }
      end = start + length;
    } else {
      end = fixedLength === undefined ? bytes.length : start + fixedLength;
    }
    if (end > bytes.length) {
      if (!header) break;
      cursor = start + 1;
      continue;
    }
    if (end - start > limit) {
      cursor = idleOnly || (delimiter && !header) ? end : start + 1;
      continue;
    }

    const footerEnd = end - (delimiter?.length ?? 0);
    const footerStart = footerEnd - (requiredFooter?.length ?? 0);
    const footerMatches =
      !requiredFooter ||
      (footerStart >= content &&
        bytes.subarray(footerStart, footerEnd).equals(requiredFooter) &&
        !isEscaped(escapes, content, footerStart));
    if (footerMatches) {
      if (!emit(start, end)) return start - framedBytes;
      framedBytes += end - start;
      cursor = end;
    } else {
      cursor = idleOnly || (delimiter && !header) ? end : start + 1;
    }
  }
  return bytes.length - framedBytes;
}

const scan: NodeActionHandler = async ({ target, params }, task) => {
  const { hostId, sessionId, sessionEpoch } = target;
  const { startEventSeq, endEventSeq, startByte } = params;
  if (
    !sessionId ||
    !sessionEpoch ||
    typeof startEventSeq !== "string" ||
    !sequence.test(startEventSeq) ||
    typeof endEventSeq !== "string" ||
    !sequence.test(endEventSeq) ||
    (startByte !== undefined &&
      (typeof startByte !== "string" || !byteOffset.test(startByte)))
  ) {
    throw new Error("Framing requires an exact session and event range");
  }
  const firstEvent = BigInt(startEventSeq);
  let cursor = firstEvent;
  let byteCursor = startByte === undefined ? undefined : BigInt(startByte);
  const end = BigInt(endEventSeq);
  if (
    end <= cursor ||
    end > maxSequence ||
    end - cursor > maxEvents ||
    (byteCursor !== undefined && byteCursor > maxSequence)
  ) {
    throw new Error("Framing scan exceeds the event range limit");
  }

  const options = framingOptions(params);
  const frames: { bytesBase64: string; source: SourceRange }[] = [];
  const buffer = Buffer.alloc(maxInputBytes);
  const parts: { end: number; event: bigint }[] = [];
  let segmentLength = 0;
  let segmentByteStart = 0n;
  let nextByte: bigint | undefined;
  let instance: string | undefined;
  let revision: string | undefined;
  let previousTime: RxTime | undefined;
  let seenBytes = 0;
  let incompleteBytes = 0;
  let nextCursor: { eventSeq: string; byteStart: string } | undefined;
  const source = { hostId, sessionId, sessionEpoch, direction: "rx" as const };

  function flushSegment(quiet = false) {
    previousTime = undefined;
    if (segmentLength === 0) return;
    let part = 0;
    const bytes = buffer.subarray(0, segmentLength);
    incompleteBytes += scanSegment(bytes, options, quiet, (start, end) => {
      while ((parts[part]?.end ?? segmentLength + 1) <= start) part++;
      const first = parts[part]?.event;
      if (first === undefined) {
        throw new Error("Framing result is missing its source range");
      }
      const absoluteStart = String(segmentByteStart + BigInt(start));
      if (frames.length >= maxFrames) {
        nextCursor = { eventSeq: String(first), byteStart: absoluteStart };
        return false;
      }
      while ((parts[part]?.end ?? segmentLength + 1) < end) part++;
      const last = parts[part]?.event;
      if (last === undefined) {
        throw new Error("Framing result is missing its source range");
      }
      frames.push({
        bytesBase64: bytes.toString("base64", start, end),
        source: {
          ...source,
          eventStart: String(first),
          eventEnd: String(last + 1n),
          byteStart: absoluteStart,
          byteEnd: String(segmentByteStart + BigInt(end)),
        },
      });
      return true;
    });
    segmentLength = 0;
    parts.length = 0;
  }

  readPages: while (cursor < end) {
    task.signal.throwIfAborted();
    const page = await task.streams.read({
      sessionId,
      sessionEpoch,
      startEventSeq: String(cursor),
      maxEvents: String(end - cursor > 100n ? 100n : end - cursor),
      maxBytes: String(rawPageBytes),
    });
    for (const event of page.events) {
      task.signal.throwIfAborted();
      const eventSeq = BigInt(event.eventSeq);
      if (eventSeq >= end) break;
      if (
        eventSeq < cursor ||
        event.hostId !== hostId ||
        event.sessionId !== sessionId ||
        event.sessionEpoch !== sessionEpoch
      ) {
        throw new Error("Unexpected framing input source");
      }
      if (
        byteCursor !== undefined &&
        (eventSeq !== firstEvent || event.kind !== "rx")
      ) {
        throw new Error(
          "Framing cursor must select a byte in the first RX event",
        );
      }
      if (event.kind === "gap" || event.kind === "configuration_boundary") {
        flushSegment();
        if (nextCursor) break readPages;
        nextByte = undefined;
      }
      if (event.kind !== "rx") continue;
      if (instance !== undefined && instance !== event.instanceEpoch) {
        flushSegment();
        nextByte = undefined;
      }
      if (revision !== undefined && revision !== event.configurationRevision) {
        flushSegment();
      }
      if (nextCursor) break readPages;
      instance = event.instanceEpoch;
      revision = event.configurationRevision;

      let bytes = Buffer.from(event.payload.bytesBase64, "base64");
      let start = BigInt(event.payload.byteStart);
      const byteEnd = BigInt(event.payload.byteEnd);
      if (
        (nextByte !== undefined && nextByte !== start) ||
        byteEnd !== start + BigInt(bytes.length)
      ) {
        throw new Error("Framing input has a discontinuous byte range");
      }
      if (byteCursor !== undefined) {
        if (byteCursor < start || byteCursor >= byteEnd) {
          throw new Error("Framing cursor is outside the first RX event");
        }
        bytes = bytes.subarray(Number(byteCursor - start));
        start = byteCursor;
        byteCursor = undefined;
      }
      seenBytes += bytes.length;
      if (seenBytes > maxInputBytes) {
        throw new Error("Framing scan exceeds the input byte limit");
      }
      nextByte = byteEnd;
      if (bytes.length === 0) continue;
      if (options.idleNs !== undefined) {
        if (previousTime) {
          const elapsed = sourceElapsed(previousTime, event.time);
          if (elapsed === undefined) flushSegment();
          else if (elapsed >= options.idleNs) flushSegment(true);
        }
        if (nextCursor) break readPages;
        previousTime = event.time;
      }
      if (segmentLength === 0) segmentByteStart = start;
      bytes.copy(buffer, segmentLength);
      segmentLength += bytes.length;
      parts.push({ end: segmentLength, event: eventSeq });
    }
    const next = BigInt(page.nextEventSeq);
    if (next <= cursor || (!page.hasMore && next < end)) {
      throw new Error("Framing event range is not available");
    }
    cursor = next;
  }
  task.signal.throwIfAborted();
  if (byteCursor !== undefined) {
    throw new Error("Framing cursor event was not available");
  }
  if (!nextCursor) flushSegment();
  return { frames, incompleteBytes, ...(nextCursor ? { nextCursor } : {}) };
};

export const register: NodeRegister = (context) => {
  context.parsers.register("swb.reference.framing.scan", scan);
  return () => {};
};
