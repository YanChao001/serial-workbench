import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

const ROWS_PER_BLOCK = 24;
const WINDOW_THRESHOLD = 192;
const ESTIMATED_ROW_HEIGHT = 40;
const OVERSCAN_BLOCKS = 2;
const STREAM_ROW = "[data-stream-row-index]";

type BlockRange = { start: number; end: number };
type Interaction = { focused?: string; anchor?: string; focus?: string };
type RowMeasurement = { rows: number; height: number };
type ViewportAnchor = {
  row: HTMLElement;
  key: string;
  inset: number;
  measurementKey: string;
  viewportHeight: number;
  scrollTop: number;
  waiting?: boolean;
};

function containingRowKey(node: Node | null, body: HTMLDivElement) {
  if (!node || !body.contains(node)) return;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(STREAM_ROW)?.dataset.streamRowKey;
}

function visibleAnchor(log: HTMLDivElement, body: HTMLDivElement) {
  const top = log.getBoundingClientRect().top + log.clientTop;
  const bottom = top + log.clientHeight;
  const target = body.querySelector<HTMLElement>(
    '[data-location-target="true"]',
  );
  if (target) {
    const bounds = target.getBoundingClientRect();
    if (bounds.bottom > top && bounds.top < bottom)
      return { row: target, inset: bounds.top - top };
  }
  for (const row of body.querySelectorAll<HTMLElement>(STREAM_ROW)) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > top && bounds.top < bottom)
      return { row, inset: bounds.top - top };
    if (bounds.top >= bottom) return;
  }
}

function blockAt(offsets: readonly number[], top: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid]! <= top) low = mid;
    else high = mid;
  }
  return low;
}

function rangeAt(
  offsets: readonly number[],
  top: number,
  viewportHeight: number,
): BlockRange {
  return {
    start: Math.max(0, blockAt(offsets, top) - OVERSCAN_BLOCKS),
    end: Math.min(
      offsets.length - 1,
      blockAt(offsets, top + viewportHeight) + 1 + OVERSCAN_BLOCKS,
    ),
  };
}

function mergeRanges(
  view: BlockRange,
  interaction: Interaction,
  findRow: (key: string) => number,
) {
  const blockFor = (key?: string) =>
    key === undefined ? -1 : Math.floor(findRow(key) / ROWS_PER_BLOCK);
  const focused = blockFor(interaction.focused);
  const anchor = blockFor(interaction.anchor);
  const focus = blockFor(interaction.focus);
  const ranges = [view];
  if (anchor >= 0 && focus >= 0)
    ranges.push({
      start: Math.min(anchor, focus),
      end: Math.max(anchor, focus) + 1,
    });
  if (focused >= 0) ranges.push({ start: focused, end: focused + 1 });
  ranges.sort((a, b) => a.start - b.start);
  const merged: BlockRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.end >= range.start)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** 测量临近行组的实际高度。所有行保持同一父节点，历史裁剪时保留原记录。 */
export function useStreamRowWindow({
  count,
  layoutKey,
  sourceKey,
  following,
  viewport,
  body,
  findRow,
}: {
  count: number;
  layoutKey: string;
  sourceKey?: string;
  following: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
  findRow: (key: string) => number;
}) {
  const enabled = count > WINDOW_THRESHOLD;
  const [measurements, setMeasurements] = useState<{
    key: string;
    sizes: ReadonlyMap<number, RowMeasurement>;
  }>();
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const [position, setPosition] = useState<BlockRange>();
  const [interaction, setInteraction] = useState<Interaction>({});
  const anchor = useRef<ViewportAnchor | undefined>(undefined);
  const indexOfRow = useEffectEvent(findRow);
  const measurementKey = JSON.stringify({ layoutKey, sourceKey, width });
  const offsets = useMemo(() => {
    const stops = [0];
    const sizes =
      measurements?.key === measurementKey ? measurements.sizes : undefined;
    for (let start = 0; start < count; start += ROWS_PER_BLOCK) {
      const rows = Math.min(count - start, ROWS_PER_BLOCK);
      const size = sizes?.get(start);
      const estimate =
        size?.rows === rows ? size.height : rows * ESTIMATED_ROW_HEIGHT;
      stops.push(stops[stops.length - 1]! + estimate);
    }
    return stops;
  }, [count, measurementKey, measurements]);
  const endOffset = offsets[offsets.length - 1]!;
  const blockCount = offsets.length - 1;
  const render = useMemo(() => {
    const tail = rangeAt(offsets, Math.max(0, endOffset - height), height);
    const view = following || !position ? tail : position;
    const ranges = enabled
      ? mergeRanges(view, interaction, findRow)
      : [{ start: 0, end: blockCount }];
    let previousEnd = 0;
    const windows = [];
    for (const range of ranges) {
      const start = Math.min(range.start, blockCount);
      const end = Math.min(range.end, blockCount);
      if (start === end) continue;
      windows.push({
        from: start * ROWS_PER_BLOCK,
        to: Math.min(count, end * ROWS_PER_BLOCK),
        before: offsets[start]! - offsets[previousEnd]!,
      });
      previousEnd = end;
    }
    return { windows, after: endOffset - offsets[previousEnd]! };
  }, [
    blockCount,
    count,
    enabled,
    endOffset,
    findRow,
    following,
    height,
    interaction,
    offsets,
    position,
  ]);

  const sync = useCallback(
    (node: HTMLDivElement) => {
      const resized =
        enabled && (node.clientWidth !== width || node.clientHeight !== height);
      if (enabled) {
        setHeight(node.clientHeight);
        setWidth(node.clientWidth);
      }
      const currentBody = body.current;
      const previous = anchor.current;
      if (following) anchor.current = undefined;
      else if (
        currentBody &&
        (!previous || (!resized && previous.scrollTop !== node.scrollTop))
      ) {
        const visible = visibleAnchor(node, currentBody);
        const key = visible?.row.dataset.streamRowKey;
        anchor.current =
          visible && key !== undefined
            ? {
                ...visible,
                key,
                measurementKey,
                viewportHeight: node.clientHeight,
                scrollTop: node.scrollTop,
              }
            : undefined;
      }
      if (!enabled && following) return;
      const next = rangeAt(offsets, node.scrollTop, node.clientHeight);
      setPosition((current) =>
        current?.start === next.start && current.end === next.end
          ? current
          : next,
      );
    },
    [body, enabled, following, height, measurementKey, offsets, width],
  );
  useLayoutEffect(() => {
    const log = viewport.current;
    const root = body.current;
    if (!log || !root) return;
    const previous = anchor.current;
    if (
      !following &&
      previous &&
      (previous.measurementKey !== measurementKey ||
        previous.viewportHeight !== height ||
        Math.abs(log.scrollTop - previous.scrollTop) <= 1)
    ) {
      let row = root.contains(previous.row) ? previous.row : undefined;
      if (!row) {
        row = Array.from(root.querySelectorAll<HTMLElement>(STREAM_ROW)).find(
          (candidate) => candidate.dataset.streamRowKey === previous.key,
        );
      }
      if (row) {
        previous.row = row;
        previous.waiting = false;
        const top = log.getBoundingClientRect().top + log.clientTop;
        const bounds = row.getBoundingClientRect();
        const inset = Math.min(
          previous.inset,
          Math.max(0, log.clientHeight - bounds.height),
        );
        const change = bounds.top - top - inset;
        if (Math.abs(change) > 0.5) log.scrollTop += change;
        previous.scrollTop = log.scrollTop;
        previous.measurementKey = measurementKey;
        previous.viewportHeight = height;
      } else if (!previous.waiting) {
        const index = indexOfRow(previous.key);
        if (index >= 0) {
          log.scrollTop = offsets[Math.floor(index / ROWS_PER_BLOCK)]!;
          previous.scrollTop = log.scrollTop;
          previous.waiting = true;
        } else anchor.current = undefined;
      }
    }
    const frame = requestAnimationFrame(() => sync(log));
    return () => cancelAnimationFrame(frame);
  }, [
    body,
    following,
    height,
    measurementKey,
    offsets,
    render,
    sync,
    viewport,
  ]);
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const document = root.ownerDocument;
    let frame: number | undefined;
    const refresh = () => {
      const native = document.getSelection();
      const focused = containingRowKey(document.activeElement, root);
      const anchor = !native?.isCollapsed
        ? containingRowKey(native?.anchorNode ?? null, root)
        : undefined;
      const focus = !native?.isCollapsed
        ? containingRowKey(native?.focusNode ?? null, root)
        : undefined;
      setInteraction((current) =>
        current.focused === focused &&
        current.anchor === anchor &&
        current.focus === focus
          ? current
          : { focused, anchor, focus },
      );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        refresh();
      });
    };
    schedule();
    document.addEventListener("selectionchange", refresh);
    root.addEventListener("focusin", refresh);
    root.addEventListener("focusout", schedule);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      root.removeEventListener("focusin", refresh);
      root.removeEventListener("focusout", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [body, sourceKey]);
  useLayoutEffect(() => {
    const log = viewport.current;
    const root = body.current;
    if (!enabled || !log || !root) return;
    const observer = new ResizeObserver(() => {
      const measured = new Map<number, RowMeasurement>();
      for (const row of root.querySelectorAll<HTMLElement>(STREAM_ROW)) {
        const index = Number(row.dataset.streamRowIndex);
        const start = index - (index % ROWS_PER_BLOCK);
        const block = measured.get(start) ?? { rows: 0, height: 0 };
        block.rows++;
        block.height += row.getBoundingClientRect().height;
        measured.set(start, block);
      }
      setHeight(log.clientHeight);
      setWidth(log.clientWidth);
      setMeasurements((current) => {
        const sizes = new Map(
          current?.key === measurementKey ? current.sizes : undefined,
        );
        let changed = false;
        for (const [start, measurement] of measured) {
          if (!measurement.height) continue;
          const existing = sizes.get(start);
          if (
            existing?.rows === measurement.rows &&
            existing.height === measurement.height
          )
            continue;
          sizes.set(start, measurement);
          changed = true;
        }
        return changed ? { key: measurementKey, sizes } : current;
      });
    });
    observer.observe(log);
    for (const row of root.querySelectorAll(STREAM_ROW)) observer.observe(row);
    return () => observer.disconnect();
  }, [body, enabled, measurementKey, render, viewport]);

  const reveal = useCallback(
    (row: number) => {
      const log = viewport.current;
      if (!enabled || !log || row < 0 || row >= count) return;
      anchor.current = undefined;
      log.scrollTop = offsets[Math.floor(row / ROWS_PER_BLOCK)]!;
      sync(log);
    },
    [count, enabled, offsets, sync, viewport],
  );
  return { enabled, ...render, sync, reveal };
}
