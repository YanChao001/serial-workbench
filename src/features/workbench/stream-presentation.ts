import type { CSSProperties } from "react";
import {
  defaults,
  type EventTime,
  type StreamItem,
  type TerminalTypography,
  type SessionState,
  type OperationState,
  type TxGate,
  type TxOutcome,
} from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";

export function workbenchStatus(
  status: SessionState | OperationState | TxGate | TxOutcome,
  labels: WorkbenchLabels,
): string {
  return {
    open: labels.connected,
    opening: labels.opening,
    closed: labels.closed,
    closing: labels.closing,
    disconnected: labels.disconnected,
    ready: labels.ready,
    configuration_pending: labels.configurationPending,
    control_unknown: labels.controlUnknown,
    queued: labels.queued,
    running: labels.running,
    cancel_requested: labels.cancelRequested,
    succeeded: labels.succeeded,
    failed: labels.failed,
    cancelled: labels.cancelled,
    interrupted: labels.interrupted,
    unknown: labels.unknown,
    accepted: labels.accepted,
    partial: labels.partial,
    rejected: labels.rejected,
  }[status];
}

const timeOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
} satisfies Intl.DateTimeFormatOptions;
const localTime = new Intl.DateTimeFormat("en-GB", timeOptions);
const dateOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
} satisfies Intl.DateTimeFormatOptions;
const localDate = new Intl.DateTimeFormat("sv-SE", dateOptions);
export function compactStreamTime(absolute: string, timeZone?: string): string {
  const value = new Date(absolute);
  if (!Number.isFinite(value.getTime())) return absolute;
  // 仅转换展示时区；原始 UTC、源时钟和纳秒数据保持不变。
  const date = (
    timeZone
      ? new Intl.DateTimeFormat("sv-SE", { ...dateOptions, timeZone })
      : localDate
  ).format(value);
  return (
    date +
    " " +
    (timeZone
      ? new Intl.DateTimeFormat("en-GB", { ...timeOptions, timeZone })
      : localTime
    ).format(value)
  );
}

export function terminalTypographyStyle(
  typography: TerminalTypography = defaults.terminalTypography,
): CSSProperties {
  return {
    // Windows WebView 不保证识别独立的 ui-monospace；共享栈提供系统等宽回退。
    fontFamily:
      typography.fontFamily === "ui-monospace"
        ? "var(--font-mono)"
        : typography.fontFamily,
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
  missingTime: string;
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
