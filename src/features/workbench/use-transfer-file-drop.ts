import { useEffect, useEffectEvent, type RefObject } from "react";
import { onTransferFileDrop, type TransferDrop } from "@/lib/tauri";

export function useTransferFileDrop(
  zone: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (drop: TransferDrop) => void,
) {
  const receive = useEffectEvent((drop: TransferDrop) => {
    const { x, y } = drop;
    if (!enabled || typeof x !== "number" || typeof y !== "number") return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const ratio = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(x / ratio, y / ratio);
    if (target && zone.current?.contains(target)) onDrop(drop);
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let stop: (() => void) | undefined;
    void onTransferFileDrop((drop) => {
      if (active) receive(drop);
    }).then(
      (unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      },
      () => {},
    );
    return () => {
      active = false;
      stop?.();
    };
  }, [enabled]);
}
