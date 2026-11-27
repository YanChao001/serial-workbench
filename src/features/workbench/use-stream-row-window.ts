import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";

const ROWS_PER_BLOCK = 24;
const WINDOW_THRESHOLD = 192;
const ESTIMATED_ROW_HEIGHT = 40;
const OVERSCAN_BLOCKS = 2;

type RowMeasurement = { rows: number; height: number };
type BlockRange = { start: number; end: number };

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
  following,
  viewport,
  body,
}: {
  count: number;
  layoutKey: string;
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
  const [position, setPosition] = useState<BlockRange>();
  const offsets = useMemo(() => {
    const stops = [0];
    if (!enabled) return stops;
    const sizes =
      measurements?.key === layoutKey ? measurements.sizes : undefined;
    for (let start = 0; start < count; start += ROWS_PER_BLOCK) {
      const rows = Math.min(count - start, ROWS_PER_BLOCK);
      const size = sizes?.get(start);
      const estimate =
        size?.rows === rows ? size.height : rows * ESTIMATED_ROW_HEIGHT;
      stops.push(stops[stops.length - 1]! + estimate);
    }
    return stops;
  }, [count, enabled, layoutKey, measurements]);
  const endOffset = offsets[offsets.length - 1]!;
  const tail = rangeAt(offsets, Math.max(0, endOffset - height), height);
  const range = following || !position ? tail : position;
  const endBlock = Math.min(range.end, offsets.length - 1);
  const startBlock = Math.min(range.start, Math.max(0, endBlock - 1));
  const first = enabled ? startBlock * ROWS_PER_BLOCK : 0;
  const end = enabled ? Math.min(count, endBlock * ROWS_PER_BLOCK) : count;
  const blocks = useMemo(
    () =>
      Array.from(
        { length: enabled ? endBlock - startBlock : 0 },
        (_, index) => {
          const start = (startBlock + index) * ROWS_PER_BLOCK;
          return { start, end: Math.min(end, start + ROWS_PER_BLOCK) };
        },
      ),
    [enabled, end, endBlock, startBlock],
  );

  const sync = useCallback(
    (node: HTMLDivElement) => {
      if (!enabled) return;
      setHeight(node.clientHeight);
      const next = rangeAt(offsets, node.scrollTop, node.clientHeight);
      setPosition((current) =>
        current?.start === next.start && current.end === next.end
          ? current
          : next,
      );
    },
    [enabled, offsets],
  );
  useLayoutEffect(() => {
    if (viewport.current) sync(viewport.current);
  }, [sync, viewport]);
  useLayoutEffect(() => {
    const log = viewport.current;
    const content = body.current;
    if (!enabled || !log || !content) return;
    const observer = new ResizeObserver((entries) => {
      const measurements = entries.flatMap(({ target, borderBoxSize }) => {
        if (!(target instanceof HTMLElement) || target === log) return [];
        const start = Number(target.dataset.streamBlock);
        const rows = target.childElementCount;
        const height =
          borderBoxSize[0]?.blockSize ?? target.getBoundingClientRect().height;
        return Number.isInteger(start) && rows > 0 && height > 0
          ? [{ start, rows, height }]
          : [];
      });
      setHeight(log.clientHeight);
      if (!measurements.length) return;
      setMeasurements((current) => {
        const previous = current?.key === layoutKey ? current.sizes : undefined;
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
        return changed ? { key: layoutKey, sizes } : current;
      });
    });
    observer.observe(log);
    for (const block of content.querySelectorAll("[data-stream-block]"))
      observer.observe(block);
    return () => observer.disconnect();
  }, [blocks, body, enabled, layoutKey, viewport]);

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
