import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { TextSendPreview } from "@/lib/text-encoding";

type Gesture = { pointer: number } | { key: string };
const START_HOLD_MS = 350;
const REPEAT_WAIT_MS = 180;

function waitForHold(ms: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** 每笔写入确认完成后，手势才安排下一笔。 */
export function useHoldSend(
  scope: string | undefined,
  preview: TextSendPreview | undefined,
  canStart: boolean,
  write: (signal: AbortSignal) => Promise<boolean>,
) {
  const gesture = useRef<{
    input: Gesture;
    controller: AbortController;
  } | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = useCallback(() => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    current.controller.abort();
    setHolding(false);
  }, []);

  useLayoutEffect(() => stop, [scope, preview, stop]);
  useEffect(() => {
    if (!scope) return;
    const hide = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [scope, stop]);

  function start(input: Gesture) {
    if (!scope || !canStart || gesture.current || document.hidden) return false;
    const controller = new AbortController();
    const { signal } = controller;
    gesture.current = { input, controller };
    setHolding(true);
    void (async () => {
      try {
        let elapsed = await waitForHold(START_HOLD_MS, signal);
        while (elapsed && !signal.aborted && (await write(signal)))
          elapsed = await waitForHold(REPEAT_WAIT_MS, signal);
      } catch {
        // 写入异常结束手势，停止安排后续发送。
      } finally {
        if (gesture.current?.controller === controller) stop();
      }
    })();
    return true;
  }

  function releasePointer(event: PointerEvent<HTMLButtonElement>) {
    const input = gesture.current?.input;
    if (input && "pointer" in input && input.pointer === event.pointerId)
      stop();
  }

  return {
    holding,
    isHolding: () => gesture.current !== null,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (
          event.isPrimary &&
          event.button === 0 &&
          start({ pointer: event.pointerId })
        )
          event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerUp: releasePointer,
      onPointerCancel: releasePointer,
      onLostPointerCapture: releasePointer,
      onBlur: stop,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Escape" && gesture.current) {
          event.preventDefault();
          stop();
          return;
        }
        if (
          (event.key !== " " && event.key !== "Enter") ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        if (!event.repeat) start({ key: event.key });
      },
      onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
        const input = gesture.current?.input;
        if (input && "key" in input && input.key === event.key) {
          event.preventDefault();
          stop();
        }
      },
    },
  };
}
