import type { Call } from "@serial-workbench/contracts";

export type FixedFramingRules = {
  width: number;
  header?: Uint8Array;
  footer?: Uint8Array;
  escape?: number;
  idleMs?: number;
};

function marker(value: Call["params"][string]) {
  if (typeof value === "string")
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function fixedFramingRules(
  params: Call["params"],
): FixedFramingRules | undefined {
  if (typeof params.fixedLength !== "number") return;
  return {
    width: params.fixedLength,
    header: marker(params.headerBase64),
    footer: marker(params.footerBase64),
    escape:
      typeof params.escapeByte === "number" ? params.escapeByte : undefined,
    idleMs:
      typeof params.idleTimeoutMs === "number"
        ? params.idleTimeoutMs
        : undefined,
  };
}

function matches(bytes: Uint8Array, start: number, pattern: Uint8Array) {
  return pattern.every((byte, index) => bytes[start + index] === byte);
}

// Keep only the suffix in which another frame can still begin. Escape parity
// before that suffix matters when the next RX begins with a marker.
export function scanMarkedFixedFrames(
  bytes: Uint8Array,
  rules: FixedFramingRules,
  escapedBefore = false,
) {
  const { width, header, footer, escape } = rules;
  const prefix = Number(escapedBefore);
  const escapeRuns =
    escape === undefined ? undefined : new Uint32Array(bytes.length + 1);
  if (escapeRuns) {
    escapeRuns[0] = prefix;
    for (let index = 0; index < bytes.length; index++)
      escapeRuns[index + 1] =
        bytes[index] === escape ? escapeRuns[index]! + 1 : 0;
  }

  function escaped(from: number, at: number) {
    const available = at - from + (from === 0 ? prefix : 0);
    return Math.min(escapeRuns?.[at] ?? 0, available) % 2 === 1;
  }

  let latest: { start: number; end: number } | undefined;
  let cursor = 0;
  while (cursor < bytes.length) {
    let start = cursor;
    const headerLength = header?.length ?? 0;
    if (header) {
      const lastStart = bytes.length - header.length;
      while (
        start <= lastStart &&
        (bytes[start] !== header[0] ||
          escaped(cursor, start) ||
          !matches(bytes, start, header))
      ) {
        start++;
      }
      if (start > lastStart)
        return {
          latest,
          pendingFrom: start,
          escapedBefore: escaped(cursor, start),
        };
    }
    const end = start + width;
    if (end > bytes.length)
      return { latest, pendingFrom: start, escapedBefore: false };
    const content = start + headerLength;
    const footerStart = end - (footer?.length ?? 0);
    if (
      footer &&
      (footerStart < content ||
        escaped(content, footerStart) ||
        !matches(bytes, footerStart, footer))
    ) {
      cursor = start + 1;
      continue;
    }
    latest = { start, end };
    cursor = end;
  }
  return { latest, pendingFrom: cursor, escapedBefore: false };
}
