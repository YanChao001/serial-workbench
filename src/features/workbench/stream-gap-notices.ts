import { useEffect, useRef } from "react";
import type { StreamItem } from "@serial-workbench/contracts";
import { recordUserLog } from "@/lib/user-log";
import { notifyWorkbenchMessage } from "./workbench-notice";

type GapHistory = { sourceSeq: bigint; readerEnd: bigint; active: boolean };
// 窗口级按源保留两个单调高水位，不缓存数据正文或随 Gap 数量增长的身份集合。
const SOURCE_LIMIT = 512;
const history = new Map<string, GapHistory>();

function sourceKey(source: {
  hostId: string;
  instanceEpoch: string;
  sessionId: string;
  sessionEpoch: string;
}) {
  return JSON.stringify([
    source.hostId,
    source.instanceEpoch,
    source.sessionId,
    source.sessionEpoch,
  ]);
}

export function useStreamGapNotices(
  items: readonly StreamItem[],
  message: string,
) {
  const previousSources = useRef(new Set<string>());
  useEffect(() => {
    const groups = new Map<
      string,
      { source: Set<bigint>; reader: Set<bigint> }
    >();
    for (const item of items) {
      if (item.kind === "source" && item.event.kind !== "gap") continue;
      const key = sourceKey(item.kind === "source" ? item.event : item.gap);
      let group = groups.get(key);
      if (!group) {
        group = { source: new Set(), reader: new Set() };
        groups.set(key, group);
      }
      if (item.kind === "reader_gap")
        group.reader.add(BigInt(item.gap.missingEventRange.end));
      else if (item.event.kind === "gap")
        group.source.add(BigInt(item.event.eventSeq));
    }
    for (const key of previousSources.current) {
      if (!groups.has(key)) {
        const previous = history.get(key);
        if (previous) previous.active = false;
      }
    }
    previousSources.current = new Set([...groups.keys()].slice(-SOURCE_LIMIT));
    for (const [key, group] of groups) {
      const previous = history.get(key) ?? {
        sourceSeq: -1n,
        readerEnd: -1n,
        active: false,
      };
      let sourceSeq = previous.sourceSeq;
      let readerEnd = previous.readerEnd;
      let count = 0;
      for (const seq of group.source)
        if (seq > previous.sourceSeq) {
          count++;
          if (seq > sourceSeq) sourceSeq = seq;
        }
      // ReaderGap 按契约覆盖连续、不重叠的源范围；end 是其单调身份边界。
      for (const end of group.reader)
        if (end > previous.readerEnd) {
          count++;
          if (end > readerEnd) readerEnd = end;
        }
      const active = group.source.size > 0 || group.reader.size > 0;
      history.delete(key);
      history.set(key, { sourceSeq, readerEnd, active });
      while (history.size > SOURCE_LIMIT)
        history.delete(history.keys().next().value!);
      for (let index = 0; index < count; index++)
        recordUserLog({ module: "display", level: "warning", message });
      if (count > 0 && !previous.active) {
        notifyWorkbenchMessage(
          JSON.stringify([
            "stream-gap",
            key,
            sourceSeq.toString(),
            readerEnd.toString(),
          ]),
          message,
        );
      }
    }
    // 卸载只结束当前视图；保留源高水位与 episode，重开不重放旧缺口。
  }, [items, message]);
}
