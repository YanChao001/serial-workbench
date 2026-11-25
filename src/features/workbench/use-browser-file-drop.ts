import { useEffect, useEffectEvent, useState, type RefObject } from "react";

export function useBrowserFileDrop(
  zone: RefObject<HTMLElement | null>,
  enabled: boolean,
  canReceive: boolean,
  onFiles: (files: FileList) => void,
) {
  const [dragging, setDragging] = useState(false);
  const receive = useEffectEvent((event: DragEvent) => {
    const data = event.dataTransfer;
    const area = zone.current;
    const inside = event.target instanceof Node && area?.contains(event.target);
    if (event.type === "dragleave") {
      if (
        inside &&
        !(
          event.relatedTarget instanceof Node &&
          area?.contains(event.relatedTarget)
        )
      )
        setDragging(false);
      return;
    }
    if (!data?.types.includes("Files")) return;
    // 工作台只在指定字段接收文件，其他落点也不能替换当前浏览器页面。
    event.preventDefault();
    if (event.type === "dragover") {
      if (inside) data.dropEffect = canReceive ? "copy" : "none";
      setDragging(Boolean(inside && canReceive));
    } else {
      setDragging(false);
      if (inside && canReceive) onFiles(data.files);
    }
  });
  useEffect(() => {
    if (!enabled) return;
    const events = ["dragover", "dragleave", "drop"] as const;
    const handle = (event: DragEvent) => receive(event);
    for (const event of events) window.addEventListener(event, handle);
    return () => {
      for (const event of events) window.removeEventListener(event, handle);
    };
  }, [enabled]);
  return enabled && canReceive && dragging;
}
