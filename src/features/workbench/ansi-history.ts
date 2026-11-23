import type { IMarker, Terminal } from "@xterm/xterm";

export type AnsiHistorySnapshot = {
  retained: number;
  first: number;
  last: number;
  atLatest: boolean;
  alternate: boolean;
  lostEarlierLines: boolean;
};

export function observeAnsiHistory(
  terminal: Terminal,
  publish: (value: AnsiHistorySnapshot) => void,
): () => void {
  let marker: IMarker | undefined;
  let frame: number | undefined;
  let closed = false;
  let lostEarlierLines = false;
  let previous: AnsiHistorySnapshot | undefined;

  function schedule() {
    if (!closed && frame === undefined)
      frame = window.requestAnimationFrame(update);
  }

  function markOldest() {
    const active = terminal.buffer.active;
    if (marker || active.type !== "normal" || !active.length) return;
    marker = terminal.registerMarker(-(active.baseY + active.cursorY));
    marker?.onDispose(() => {
      marker = undefined;
      if (!closed) lostEarlierLines = true;
      schedule();
    });
  }

  function update() {
    frame = undefined;
    markOldest();
    const active = terminal.buffer.active;
    const next = {
      retained: active.length,
      first: active.viewportY + 1,
      last: Math.min(active.length, active.viewportY + terminal.rows),
      atLatest: active.viewportY === active.baseY,
      alternate: active.type === "alternate",
      lostEarlierLines,
    };
    if (
      previous?.retained === next.retained &&
      previous.first === next.first &&
      previous.last === next.last &&
      previous.atLatest === next.atLatest &&
      previous.alternate === next.alternate &&
      previous.lostEarlierLines === next.lostEarlierLines
    )
      return;
    previous = next;
    publish(next);
  }

  markOldest();
  schedule();
  const subscriptions = [
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.onWriteParsed(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  return () => {
    closed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    for (const subscription of subscriptions) subscription.dispose();
    marker?.dispose();
  };
}
