import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
export function useNativeResource<T>(
  load: () => Promise<T>,
  enabled = isTauri(),
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const value = await load();
      if (generation.current === current) setData(value);
    } catch (reason) {
      if (generation.current === current) setError(reason);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [enabled, load]);
  useEffect(() => {
    void reload();
    return invalidate;
  }, [reload, invalidate]);
  return { data, error, loading, reload };
}
