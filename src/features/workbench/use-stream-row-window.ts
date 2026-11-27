import {
  useCallback,
  useEffect,
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

type RowMeasurement = { rows: number; height: number };
type BlockRange = { start: number; end: number };
type ViewportAnchor = {
  row: HTMLElement;
  inset: number;
  scrollTop: number;
  sourceKey?: string;
};

function containingBlock(node: Node | null, body: HTMLDivElement) {
  if (!node || !body.contains(node)) return;
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>("[data-stream-block]");
  if (block) return Number(block.dataset.streamBlock) / ROWS_PER_BLOCK;
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
  for (const block of body.querySelectorAll<HTMLElement>(
    "[data-stream-block]",
  )) {
    const bounds = block.getBoundingClientRect();
    if (bounds.bottom <= top) continue;
    if (bounds.top >= bottom) return;
    for (const row of block.children) {
      if (!(row instanceof HTMLElement)) continue;
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > top && bounds.top < bottom)
        return { row, inset: bounds.top - top };
    }
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

/** 按小组测量可变高记录，视口内的节点保持普通流式排版。 */
export function useStreamRowWindow({
  count,
  layoutKey,
  sourceKey,
  following,
  viewport,
  body,
}: {
  count: number;
  layoutKey: string;
  sourceKey?: string;
  following: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
}) {
  const enabled = count > WINDOW_THRESHOLD;
  const [measurements, setMeasurements] = useState<{
    key: string;
    sizes: ReadonlyMap<number, RowMeasurement>;
  }>();
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const [position, setPosition] = useState<BlockRange>();
  const [interaction, setInteraction] = useState<BlockRange>();
  const anchor = useRef<ViewportAnchor | undefined>(undefined);
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
  const tail = rangeAt(offsets, Math.max(0, endOffset - height), height);
  const range = following || !position ? tail : position;
  const blockCount = offsets.length - 1;
  const endBlock = enabled
    ? Math.min(Math.max(range.end, interaction?.end ?? 0), blockCount)
    : blockCount;
  const startBlock = enabled
    ? Math.min(range.start, interaction?.start ?? range.start, endBlock - 1)
    : 0;
  const first = startBlock * ROWS_PER_BLOCK;
  const end = Math.min(count, endBlock * ROWS_PER_BLOCK);
  const blocks = useMemo(
    () =>
      Array.from({ length: endBlock - startBlock }, (_, index) => {
        const start = (startBlock + index) * ROWS_PER_BLOCK;
        return { start, end: Math.min(end, start + ROWS_PER_BLOCK) };
      }),
    [end, endBlock, startBlock],
  );

  const sync = useCallback(
    (node: HTMLDivElement) => {
      setHeight(node.clientHeight);
      setWidth(node.clientWidth);
      const currentBody = body.current;
      const previous = anchor.current;
      if (following) anchor.current = undefined;
      else if (
        currentBody &&
        (!previous ||
          previous.sourceKey !== sourceKey ||
          previous.scrollTop !== node.scrollTop ||
          !currentBody.contains(previous.row))
      ) {
        const visible = visibleAnchor(node, currentBody);
        anchor.current = visible && {
          ...visible,
          scrollTop: node.scrollTop,
          sourceKey,
        };
      }
      const next = rangeAt(offsets, node.scrollTop, node.clientHeight);
      setPosition((current) =>
        current?.start === next.start && current.end === next.end
          ? current
          : next,
      );
    },
    [body, following, offsets, sourceKey],
  );
  useLayoutEffect(() => {
    const log = viewport.current;
    if (!log) return;
    const previous = anchor.current;
    if (
      !following &&
      previous &&
      previous.sourceKey === sourceKey &&
      Math.abs(log.scrollTop - previous.scrollTop) <= 1 &&
      body.current?.contains(previous.row)
    ) {
      const top = log.getBoundingClientRect().top + log.clientTop;
      const bounds = previous.row.getBoundingClientRect();
      const inset = Math.min(
        previous.inset,
        Math.max(0, log.clientHeight - bounds.height),
      );
      const change = bounds.top - top - inset;
      if (Math.abs(change) > 0.5) {
        log.scrollTop += change;
        previous.scrollTop = log.scrollTop;
      }
    }
    const frame = requestAnimationFrame(() => sync(log));
    return () => cancelAnimationFrame(frame);
  }, [body, following, height, sourceKey, sync, viewport]);
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const document = root.ownerDocument;
    let frame: number | undefined;
    const refresh = () => {
      const selection = document.getSelection();
      const blocks = [
        containingBlock(document.activeElement, root),
        ...(!selection?.isCollapsed
          ? [
              containingBlock(selection?.anchorNode ?? null, root),
              containingBlock(selection?.focusNode ?? null, root),
            ]
          : []),
      ].filter((index) => index !== undefined);
      const next = blocks.length
        ? { start: Math.min(...blocks), end: Math.max(...blocks) + 1 }
        : undefined;
      setInteraction((current) =>
        current?.start === next?.start && current?.end === next?.end
          ? current
          : next,
      );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        refresh();
      });
    };
    document.addEventListener("selectionchange", refresh);
    root.addEventListener("focusin", refresh);
    root.addEventListener("focusout", schedule);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      root.removeEventListener("focusin", refresh);
      root.removeEventListener("focusout", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [body]);
  useLayoutEffect(() => {
    const log = viewport.current;
    const content = body.current;
    if (!log || !content || !blocks.length) return;
    const observer = new ResizeObserver((entries) => {
      const measurements = entries.flatMap(({ target, borderBoxSize }) => {
        if (!(target instanceof HTMLElement) || target === log) return [];
        const start = Number(target.dataset.streamBlock);
        const rows = target.childElementCount;
        const height =
          borderBoxSize?.[0]?.blockSize ??
          target.getBoundingClientRect().height;
        return Number.isInteger(start) && rows > 0 && height > 0
          ? [{ start, rows, height }]
          : [];
      });
      setHeight(log.clientHeight);
      setWidth(log.clientWidth);
      if (!measurements.length) return;
      setMeasurements((current) => {
        const previous =
          current?.key === measurementKey ? current.sizes : undefined;
        const sizes = new Map(previous);
        let changed = false;
        for (const measurement of measurements) {
          const existing = sizes.get(measurement.start);
          if (
            existing?.rows === measurement.rows &&
            existing.height === measurement.height
          ) {
            continue;
          }
          sizes.set(measurement.start, measurement);
          changed = true;
        }
        return changed ? { key: measurementKey, sizes } : current;
      });
    });
    observer.observe(log);
    for (const block of content.querySelectorAll("[data-stream-block]"))
      observer.observe(block);
    return () => observer.disconnect();
  }, [blocks, body, measurementKey, viewport]);

  const reveal = useCallback(
    (row: number) => {
      const log = viewport.current;
      if (!enabled || !log || row < 0 || row >= count) return;
      log.scrollTop = offsets[Math.floor(row / ROWS_PER_BLOCK)]!;
      sync(log);
    },
    [count, enabled, offsets, sync, viewport],
  );
  return {
    enabled,
    first,
    end,
    blocks,
    before: offsets[startBlock]!,
    after: endOffset - offsets[endBlock]!,
    sync,
    reveal,
  };
}
