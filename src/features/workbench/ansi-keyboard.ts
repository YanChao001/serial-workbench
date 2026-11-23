import type { Operation, TextEncoding } from "@serial-workbench/contracts";
import { encodeText } from "@/lib/text-encoding";
import type { AnsiPasteTarget } from "./ansi-paste";

const MAX_PENDING_KEYS = 4 * 1024;
const COALESCE_MS = 12;
const WINDOW_SIZE_SETTLE_MS = 150;
export const MAX_ANSI_WINDOW_DIMENSION = 65_535;
const ESC = "\x1b";
const protocolEncoder = new TextEncoder();

export type AnsiKeyboardTarget = {
  scope: string;
  send: (bytes: Uint8Array, signal: AbortSignal) => Promise<Operation>;
  paste?: AnsiPasteTarget;
};

export function isAnsiWindowDimension(size: number): boolean {
  return (
    Number.isInteger(size) && size > 0 && size <= MAX_ANSI_WINDOW_DIMENSION
  );
}

export function encodeAnsiKey(
  value: string,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey">,
  encoding: TextEncoding,
): Uint8Array {
  if (
    event.altKey &&
    !event.ctrlKey &&
    Array.from(event.key).length === 1 &&
    value.startsWith(ESC) &&
    Array.from(value.slice(1)).length === 1
  ) {
    const body = encodeText(value.slice(1), encoding);
    const bytes = new Uint8Array(body.length + 1);
    bytes[0] = 0x1b;
    bytes.set(body, 1);
    return bytes;
  }
  // VT escape sequences and C0/DEL are protocol bytes under every text encoding.
  const code = value.charCodeAt(0);
  if (
    value.startsWith(ESC) ||
    (value.length === 1 && (code < 32 || code === 127))
  )
    return protocolEncoder.encode(value);
  return encodeText(value, encoding);
}

export function createAnsiKeyboardWriter(
  send: AnsiKeyboardTarget["send"],
  onStop: (reason: "overflow" | "operation") => void,
) {
  const controller = new AbortController();
  const queued = new Uint8Array(MAX_PENDING_KEYS);
  let length = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let wantedSize: string | undefined;
  let pendingSize: string | undefined;
  let submittedSize: string | undefined;

  function clearWindowSize() {
    clearTimeout(resizeTimer);
    resizeTimer = undefined;
    wantedSize = undefined;
    pendingSize = undefined;
    submittedSize = undefined;
  }

  function cancel() {
    controller.abort();
    clearTimeout(timer);
    timer = undefined;
    length = 0;
    clearWindowSize();
  }

  function stop(reason: "overflow" | "operation") {
    cancel();
    onStop(reason);
  }

  function schedule() {
    if (
      controller.signal.aborted ||
      inFlight ||
      timer !== undefined ||
      (length === 0 && !pendingSize)
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, COALESCE_MS);
  }

  async function flush() {
    if (length === 0 && !pendingSize) return;
    const resizeBytes = pendingSize
      ? protocolEncoder.encode(pendingSize)
      : undefined;
    const bytes = new Uint8Array(length + (resizeBytes?.length ?? 0));
    bytes.set(queued.subarray(0, length));
    if (resizeBytes) {
      bytes.set(resizeBytes, length);
      submittedSize = pendingSize;
      pendingSize = undefined;
    }
    length = 0;
    inFlight = true;
    try {
      const operation = await send(bytes, controller.signal);
      if (
        !controller.signal.aborted &&
        (operation.state !== "succeeded" ||
          operation.result?.kind !== "tx" ||
          operation.result.value.outcome !== "accepted")
      )
        stop("operation");
    } catch {
      if (!controller.signal.aborted) stop("operation");
    } finally {
      inFlight = false;
      schedule();
    }
  }

  return {
    cancel,
    clearWindowSize,
    reportWindowSize(rows: number, cols: number) {
      if (
        controller.signal.aborted ||
        ![rows, cols].every(isAnsiWindowDimension)
      )
        return;
      const size = `${ESC}[8;${rows};${cols}t`;
      if (wantedSize === size) return;
      wantedSize = size;
      clearTimeout(resizeTimer);
      resizeTimer = undefined;
      pendingSize = undefined;
      if (submittedSize === size) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        pendingSize = size;
        schedule();
      }, WINDOW_SIZE_SETTLE_MS);
    },
    enqueue(bytes: Uint8Array) {
      if (controller.signal.aborted) return false;
      if (length + bytes.length > queued.length) {
        stop("overflow");
        return false;
      }
      queued.set(bytes, length);
      length += bytes.length;
      schedule();
      return true;
    },
  };
}
