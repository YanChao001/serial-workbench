import type { Operation, TextEncoding } from "@serial-workbench/contracts";
import { encodeText } from "@/lib/text-encoding";
import type { AnsiPasteTarget } from "./ansi-paste";

const MAX_PENDING_KEYS = 4 * 1024;
const COALESCE_MS = 12;
const ESC = "\x1b";
const protocolEncoder = new TextEncoder();

export type AnsiKeyboardTarget = {
  scope: string;
  send: (bytes: Uint8Array, signal: AbortSignal) => Promise<Operation>;
  paste?: AnsiPasteTarget;
};

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

  function cancel() {
    controller.abort();
    clearTimeout(timer);
    timer = undefined;
    length = 0;
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
      length === 0
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, COALESCE_MS);
  }

  async function flush() {
    const bytes = queued.slice(0, length);
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
    enqueue(bytes: Uint8Array) {
      if (controller.signal.aborted) return;
      if (length + bytes.length > queued.length) {
        stop("overflow");
        return;
      }
      queued.set(bytes, length);
      length += bytes.length;
      schedule();
    },
  };
}
