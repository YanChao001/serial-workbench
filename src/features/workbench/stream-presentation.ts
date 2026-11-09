import type { CSSProperties } from "react";
import {
  defaults,
  type EventTime,
  type StreamItem,
  type TerminalTypography,
} from "@serial-workbench/contracts";

export function terminalTypographyStyle(
  typography: TerminalTypography = defaults.terminalTypography,
): CSSProperties {
  return {
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeightPercent / 100,
    fontVariantLigatures: typography.ligatures ? "normal" : "none",
  };
}

export type StreamTimePresentation = {
  absolute: string | null;
  absoluteSource: "source" | "received" | null;
  relativeNs: string | null;
  intervalNs: string | null;
  time?: EventTime;
};

export type StreamPresentationLabels = {
  timeMode: string;
  absoluteTime: string;
  relativeTime: string;
  intervalTime: string;
  timeDetails: string;
  clock: string;
  timeSource: string;
  resolution: string;
  missingTime: string;
  receivedTime: string;
  sourceTime: string;
  replay: string;
};

export function presentStreamTimes(
  items: readonly StreamItem[],
): StreamTimePresentation[] {
  const origins = new Map<string, bigint>();
  let previous: { key: string; ns: bigint } | undefined;
  return items.map((item) => {
    if (item.kind === "reader_gap") {
      previous = undefined;
      return {
        absolute: null,
        absoluteSource: null,
        relativeNs: null,
        intervalNs: null,
      };
    }
    const { event } = item;
    const { time } = event;
    const key = JSON.stringify([
      event.hostId,
      event.instanceEpoch,
      event.sessionId,
      event.sessionEpoch,
      time.clockId,
    ]);
    const ns = BigInt(time.sourceMonoNs);
    const origin =
      previous?.key === key && ns < previous.ns ? ns : (origins.get(key) ?? ns);
    origins.set(key, origin);
    const interval =
      previous?.key === key && ns >= previous.ns && event.kind !== "gap"
        ? (ns - previous.ns).toString()
        : null;
    previous = event.kind === "gap" ? undefined : { key, ns };
    return {
      absolute: time.sourceWallTime ?? time.receivedWallTime,
      absoluteSource: time.sourceWallTime ? "source" : "received",
      relativeNs: (ns - origin).toString(),
      intervalNs: interval,
      time,
    };
  });
}
