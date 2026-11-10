import { useEffect, useState } from "react";
import { nativeErrorCode } from "@/lib/native-error";

type MetricsReader<T> = (signal?: AbortSignal) => Promise<T>;

/** 指标仅在页面可见时顺序采样，切换来源后不呈现旧观测值。 */
export function useMetricsReader<T>(
  read: MetricsReader<T>,
  contextKey?: string,
) {
  const [snapshot, setSnapshot] = useState<{
    read: MetricsReader<T>;
    contextKey?: string;
    value?: T;
    error?: { code?: string };
    loading: boolean;
  }>({ read, contextKey, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot({ read, contextKey, loading: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    async function poll() {
      if (controller.signal.aborted || reading || document.hidden) return;
      reading = true;
      try {
        const value = await read(controller.signal);
        if (!controller.signal.aborted)
          setSnapshot({ read, contextKey, value, loading: false });
      } catch (reason: unknown) {
        if (!controller.signal.aborted)
          setSnapshot((current) => ({
            read,
            contextKey,
            value:
              current.read === read && current.contextKey === contextKey
                ? current.value
                : undefined,
            error: { code: nativeErrorCode(reason) },
            loading: false,
          }));
      } finally {
        reading = false;
        if (!controller.signal.aborted && !document.hidden)
          timer = setTimeout(() => void poll(), 1000);
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [read, contextKey]);
  return snapshot.read === read && snapshot.contextKey === contextKey
    ? snapshot
    : { value: undefined, error: undefined, loading: true };
}
