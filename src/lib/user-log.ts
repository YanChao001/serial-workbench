export const USER_LOG_MODULES = [
  "connection",
  "serial",
  "workspace",
  "transfer",
  "capture",
  "display",
  "settings",
  "application",
] as const;
export type UserLogModule = (typeof USER_LOG_MODULES)[number];
export type UserLogLevel = "info" | "warning" | "error";
export type UserLogInput = {
  module: UserLogModule;
  level: UserLogLevel;
  /** 传入已本地化、可向用户展示的摘要；不接纳操作输入或原始通信内容。 */
  message: string;
  code?: string;
  context?: string;
};
export type UserLogEntry = Readonly<
  UserLogInput & {
    id: number;
    firstAt: string;
    lastAt: string;
    count: number;
  }
>;

const LIMIT = 256;
const listeners = new Set<() => void>();
let sequence = 0;
let records: Array<{
  fingerprint: string;
  entry: UserLogEntry;
  occurrences: string[];
}> = [];
let snapshot: readonly UserLogEntry[] = [];
function publish() {
  snapshot = records.map((record) => record.entry);
  for (const listener of listeners) listener();
}
export function getUserLog(): readonly UserLogEntry[] {
  return snapshot;
}
export function subscribeUserLog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clearUserLog() {
  records = [];
  publish();
}

/** 同一故障的再次发生合并计数；同一事件的重渲染与 StrictMode 不重复入账。 */
export function recordUserLog(input: UserLogInput, occurrenceId?: string) {
  const safe: UserLogInput = {
    ...input,
    message: input.message.slice(0, 2048),
    context: input.context?.slice(0, 256),
    code:
      input.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code)
        ? input.code
        : undefined,
  };
  const fingerprint = JSON.stringify([
    safe.module,
    safe.level,
    safe.code,
    safe.context,
    safe.message,
  ]);
  const index = records.findIndex(
    (record) => record.fingerprint === fingerprint,
  );
  const previous = records[index];
  if (occurrenceId && previous?.occurrences.includes(occurrenceId)) return;
  const now = new Date().toISOString();
  const entry: UserLogEntry = previous
    ? {
        ...previous.entry,
        lastAt: now,
        count: Math.min(Number.MAX_SAFE_INTEGER, previous.entry.count + 1),
      }
    : { ...safe, id: ++sequence, firstAt: now, lastAt: now, count: 1 };
  const occurrences = occurrenceId
    ? [...(previous?.occurrences ?? []), occurrenceId].slice(-32)
    : (previous?.occurrences ?? []);
  records = [
    { fingerprint, entry, occurrences },
    ...records.filter((record) => record !== previous),
  ].slice(0, LIMIT);
  publish();
}
