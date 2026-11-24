import {
  ProtocolFieldError,
  type FieldReading,
  type compileProtocolFields,
} from "../reference-framing/protocol-fields.ts";

const maxFrames = 128;
const maxFrameBytes = 4096;
const maxTotalBytes = 65_536;

type Codec = ReturnType<typeof compileProtocolFields>;
type TimePoint = { clockId: string; monoNs: bigint; segment: number };

export type ComparisonFrame = {
  position: bigint;
  bytes: Uint8Array;
  time?: TimePoint;
};

export type FrameAlignment =
  | { kind: "ordinal" }
  | { kind: "prefix"; length: number }
  | { kind: "fields"; ids: readonly string[] };

type PreparedFrame = ComparisonFrame & {
  elapsedNs?: bigint;
  readings?: readonly FieldReading[];
  decodeFailure?: string;
};

function decodeFrame(bytes: Uint8Array, codec: Codec | undefined) {
  if (!codec) return {};
  try {
    return { readings: codec.decode(bytes) };
  } catch (error) {
    if (!(error instanceof ProtocolFieldError)) throw error;
    return { decodeFailure: error.path };
  }
}

function prepare(
  frames: readonly ComparisonFrame[],
  codec: Codec | undefined,
  signal?: AbortSignal,
) {
  if (frames.length > maxFrames) throw new RangeError("Too many frames");
  const anchor = frames[0]?.time;
  let previousTime = anchor?.monoNs;
  let previousPosition = 0n;
  let total = 0;
  return frames.map((frame): PreparedFrame => {
    signal?.throwIfAborted();
    const { bytes, position, time } = frame;
    total += bytes.length;
    if (
      !bytes.length ||
      bytes.length > maxFrameBytes ||
      total > maxTotalBytes ||
      position <= previousPosition
    )
      throw new RangeError("Invalid frame position or byte budget");
    previousPosition = position;
    // 各侧只累计同一连续片段内从所选首帧开始的耗时。
    previousTime =
      time &&
      anchor &&
      previousTime !== undefined &&
      time.monoNs >= previousTime &&
      time.clockId === anchor.clockId &&
      time.segment === anchor.segment
        ? time.monoNs
        : undefined;
    return {
      ...frame,
      elapsedNs:
        previousTime === undefined ? undefined : previousTime - anchor!.monoNs,
      ...decodeFrame(bytes, codec),
    };
  });
}

function key(frame: PreparedFrame, alignment: FrameAlignment) {
  switch (alignment.kind) {
    case "ordinal":
      return String(frame.position);
    case "prefix":
      if (frame.bytes.length < alignment.length) return;
      return String.fromCharCode(...frame.bytes.subarray(0, alignment.length));
    case "fields": {
      const parts = alignment.ids.map((id) =>
        frame.readings?.find((field) => field.id === id),
      );
      if (parts.some((field) => field === undefined)) return;
      return JSON.stringify(
        parts.map((field) => field!.rawValue ?? field!.rawHex),
      );
    }
  }
}

function positionsByKey(keys: readonly (string | undefined)[]) {
  const positions = new Map<string, number[]>();
  keys.forEach((value, index) => {
    if (value === undefined) return;
    const matches = positions.get(value);
    if (matches) matches.push(index);
    else positions.set(value, [index]);
  });
  return positions;
}

function byteChanges(left: Uint8Array, right: Uint8Array) {
  const ranges: { start: number; end: number }[] = [];
  let count = 0;
  for (
    let position = 0;
    position < Math.max(left.length, right.length);
    position++
  ) {
    if (left[position] === right[position]) continue;
    count++;
    const previous = ranges.at(-1);
    if (previous?.end === position) previous.end++;
    else ranges.push({ start: position, end: position + 1 });
  }
  return { count, ranges };
}

function fieldChanges(
  left: readonly FieldReading[] | undefined,
  right: readonly FieldReading[] | undefined,
) {
  if (!left || !right) return;
  const rightById = new Map(right.map((field) => [field.id, field]));
  return left.flatMap((field) => {
    const other = rightById.get(field.id);
    if (!other) return [];
    return field.rawHex !== other.rawHex ||
      field.value !== other.value ||
      field.label !== other.label ||
      field.calibration?.status !== other.calibration?.status ||
      field.checksum?.valid !== other.checksum?.valid
      ? [{ id: field.id, left: field, right: other }]
      : [];
  });
}

function row(
  left: PreparedFrame | undefined,
  right: PreparedFrame | undefined,
  matchingKey: string | undefined,
  repeatedKey: boolean,
) {
  return {
    left,
    right,
    keyAvailable: matchingKey !== undefined,
    repeatedKey,
    bytes: left && right ? byteChanges(left.bytes, right.bytes) : undefined,
    fields:
      left && right ? fieldChanges(left.readings, right.readings) : undefined,
    elapsedDeltaNs:
      left?.elapsedNs !== undefined && right?.elapsedNs !== undefined
        ? right.elapsedNs - left.elapsedNs
        : undefined,
  };
}

export function compareSessionFrames(
  leftFrames: readonly ComparisonFrame[],
  rightFrames: readonly ComparisonFrame[],
  alignment: FrameAlignment,
  codec?: Codec,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    alignment.kind === "prefix" &&
    (!Number.isInteger(alignment.length) ||
      alignment.length < 1 ||
      alignment.length > 32)
  )
    throw new RangeError("Prefix length must be from 1 to 32");
  if (
    alignment.kind === "fields" &&
    (!codec ||
      !alignment.ids.length ||
      alignment.ids.length > 4 ||
      new Set(alignment.ids).size !== alignment.ids.length)
  )
    throw new RangeError("Choose one to four distinct fields");

  const left = prepare(leftFrames, codec, signal);
  const right = prepare(rightFrames, codec, signal);
  const leftKeys = left.map((frame) => key(frame, alignment));
  const rightKeys = right.map((frame) => key(frame, alignment));
  const leftPositions = positionsByKey(leftKeys);
  const rightPositions = positionsByKey(rightKeys);
  const nextByKey = new Map<string, number>();
  const matchedRight = new Set<number>();
  const repeated = (value: string | undefined) =>
    value !== undefined &&
    ((leftPositions.get(value)?.length ?? 0) > 1 ||
      (rightPositions.get(value)?.length ?? 0) > 1);

  const rows = left.map((frame, index) => {
    signal?.throwIfAborted();
    const value = leftKeys[index];
    if (value === undefined) return row(frame, undefined, value, false);
    const occurrence = nextByKey.get(value) ?? 0;
    nextByKey.set(value, occurrence + 1);
    const rightIndex = rightPositions.get(value)?.[occurrence];
    if (rightIndex !== undefined) matchedRight.add(rightIndex);
    return row(
      frame,
      rightIndex === undefined ? undefined : right[rightIndex],
      value,
      repeated(value),
    );
  });
  right.forEach((frame, index) => {
    const value = rightKeys[index];
    if (!matchedRight.has(index))
      rows.push(row(undefined, frame, value, repeated(value)));
  });
  return rows;
}

export type SessionComparisonRow = ReturnType<
  typeof compareSessionFrames
>[number];
