import type { Terminal } from "@xterm/xterm";
import { isMacOS } from "@/lib/platform";

const sgrPrefix = "\x1b[<";
const legacyPrefix = "\x1b[M";
const protocolEncoder = new TextEncoder();
const mouseEvents = ["mousedown", "mouseup", "mousemove", "wheel"] as const;
const buttonBits = [1, 4, 2];

export function selectsAnsiText(event: MouseEvent): boolean {
  return isMacOS() ? event.altKey : event.shiftKey;
}

function reportBytes(report: string, binary: boolean): Uint8Array | undefined {
  if (binary) {
    if (report.length === 6 && report.startsWith(legacyPrefix))
      return Uint8Array.from(report, (character) => character.charCodeAt(0));
    return;
  }
  if (report.startsWith(sgrPrefix) && /^\d+;\d+;\d+[Mm]$/.test(report.slice(3)))
    return protocolEncoder.encode(report);
}

export function bindAnsiMouse(
  terminal: Terminal,
  enabled: () => boolean,
  enqueue: (bytes: Uint8Array) => void,
): () => void {
  const { element, textarea } = terminal;
  if (!element || !textarea) return () => undefined;
  const surface = element;
  const document = textarea.ownerDocument;
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  let current: MouseEvent | null = null;
  let sentButtons = 0;

  const clear = () => {
    current = null;
    sentButtons = 0;
  };
  function capture(event: MouseEvent) {
    current = null;
    if (!enabled() || document.activeElement !== textarea) {
      clear();
      return;
    }
    if (!event.isTrusted) return;
    const inside = event.composedPath().includes(surface);
    const bit = buttonBits[event.button] ?? 0;
    const held = sentButtons & event.buttons;
    if (event.type === "mouseup") {
      if (sentButtons & bit) current = event;
    } else if (event.type === "mousemove" && event.buttons) {
      if (held) current = event;
    } else if (inside) {
      current = event;
    }
    sentButtons = held;
    if (event.type !== "mouseup" && (selectsAnsiText(event) || event.metaKey))
      current = null;
  }
  function forward(report: string, binary: boolean) {
    const event = current;
    // xterm uses these channels for keyboard, paste and device-generated replies, too.
    // DOM dispatch sets eventPhase back to NONE before any later report can use it.
    if (!event?.eventPhase || !enabled() || document.activeElement !== textarea)
      return;
    const bytes = reportBytes(report, binary);
    if (!bytes) return;
    current = null;
    if (event.type === "mousedown")
      sentButtons |= buttonBits[event.button] ?? 0;
    enqueue(bytes);
  }

  for (const type of mouseEvents)
    document.addEventListener(type, capture, options);
  textarea.addEventListener("blur", clear, options);
  const data = terminal.onData((report) => forward(report, false));
  const binary = terminal.onBinary((report) => forward(report, true));
  return () => {
    listeners.abort();
    data.dispose();
    binary.dispose();
  };
}
