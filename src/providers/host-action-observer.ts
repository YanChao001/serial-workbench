import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "./host-context";

type Watcher = {
  inputs: readonly HostActionCheckInput[];
  entries: Entry[];
  listener(values: readonly HostActionAvailability[]): void;
};
type Entry = {
  input: HostActionCheckInput;
  watchers: Set<Watcher>;
  version: number;
  pending: boolean;
  dueAt: number;
  expiresAt?: number;
  value?: HostActionAvailability;
};

/** 可执行性是短期观察；每个输入独立续检，实际提交仍由 Host 验权。 */
export function createHostActionObserver(
  check: HostContextValue["checkAction"],
  signal: AbortSignal,
) {
  const maxAgeMs = 1000;
  const refreshMs = maxAgeMs / 2;
  const concurrency = 4;
  const entries = new Map<string, Entry>();
  const watchers = new Set<Watcher>();
  let inputCount = 0;
  let inFlight = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === "undefined" || !document.hidden;
  const key = (input: HostActionCheckInput) =>
    JSON.stringify([
      input.actionId,
      input.target.hostId,
      input.target.kind,
      input.target.id,
      input.target.sessionId,
      input.target.sessionEpoch,
      input.params,
    ]);
  function emit(affected: Iterable<Watcher>) {
    const now = performance.now();
    for (const watcher of affected) {
      if (!watchers.has(watcher)) continue;
      watcher.listener(
        watcher.entries.map((entry, index) => ({
          input: watcher.inputs[index]!,
          result:
            entry.expiresAt !== undefined && now >= entry.expiresAt
              ? null
              : (entry.value?.result ?? null),
          error: entry.value?.error ?? null,
        })),
      );
    }
  }
  function run() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    const now = performance.now();
    const changed = new Set<Watcher>();
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        entry.value = undefined;
        entry.expiresAt = undefined;
        for (const watcher of entry.watchers) changed.add(watcher);
      }
      // 短暂重订阅可以复用未过期结果；退休缓存也有独立数量上限。
      if (
        !entry.watchers.size &&
        !entry.pending &&
        (entry.value === undefined || entries.size > 256)
      )
        entries.delete(key);
    }
    emit(changed);
    if (visible()) {
      // 慢查询完成时旧条目可能已到续检时间，按 Map 顺序会让它立即
      // 抢回名额。先服务等待最久的到期输入，避免后来的参数检查饥饿。
      const ready = [...entries.values()]
        .filter(
          (entry) =>
            entry.watchers.size && !entry.pending && entry.dueAt <= now,
        )
        .sort((left, right) => left.dueAt - right.dueAt);
      for (const entry of ready) {
        if (inFlight >= concurrency) break;
        start(entry);
      }
    }
    let next = Infinity;
    for (const entry of entries.values()) {
      if (entry.expiresAt !== undefined) next = Math.min(next, entry.expiresAt);
      if (
        visible() &&
        entry.watchers.size &&
        !entry.pending &&
        inFlight < concurrency
      )
        next = Math.min(next, entry.dueAt);
    }
    if (Number.isFinite(next))
      timer = setTimeout(run, Math.max(0, next - performance.now()));
  }
  function start(entry: Entry) {
    entry.pending = true;
    inFlight++;
    const version = entry.version;
    const startedAt = performance.now();
    void Promise.resolve()
      .then(() => check(entry.input, signal))
      .then(
        (result) => {
          if (disposed || version !== entry.version) return;
          entry.dueAt = startedAt + refreshMs;
          if (performance.now() < startedAt + maxAgeMs) {
            // checkAction 已核对 actionId 和完整 target；同一输入的续检只可能改变 allowed。
            // 有效期仍按这次查询刷新，界面仅在可见结果变化时接收新状态。
            const unchanged =
              entry.value?.error === null &&
              entry.value.result?.allowed === result.allowed;
            entry.expiresAt = startedAt + maxAgeMs;
            if (!unchanged) {
              entry.value = { input: entry.input, result, error: null };
              emit(entry.watchers);
            }
          }
        },
        (error) => {
          if (disposed || version !== entry.version) return;
          entry.expiresAt = undefined;
          entry.dueAt = performance.now() + refreshMs;
          entry.value = {
            input: entry.input,
            result: null,
            error: error instanceof Error ? error : new Error(String(error)),
          };
          emit(entry.watchers);
        },
      )
      .finally(() => {
        // 旧输入和已撤销观察者的在途读取也实际结束后才归还并发名额。
        entry.pending = false;
        inFlight--;
        run();
      });
  }
  function invalidate() {
    const now = performance.now();
    for (const entry of entries.values()) {
      entry.version++;
      entry.value = undefined;
      entry.expiresAt = undefined;
      entry.dueAt = now;
    }
    emit(watchers);
    run();
  }
  function refresh() {
    const now = performance.now();
    for (const entry of entries.values())
      entry.dueAt = Math.min(now, entry.dueAt);
    run();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    entries.clear();
    watchers.clear();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", refresh);
    if (typeof window !== "undefined")
      window.removeEventListener("focus", refresh);
    signal.removeEventListener("abort", dispose);
  }
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", refresh);
  if (typeof window !== "undefined") window.addEventListener("focus", refresh);
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  return {
    invalidate,
    watch(
      inputs: readonly HostActionCheckInput[],
      listener: Watcher["listener"],
    ) {
      // Host 可在旧渲染提交 effect 前退休；晚注册只撤销可执行性，不重新占用检查资源。
      if (disposed || signal.aborted) {
        listener(inputs.map((input) => ({ input, result: null, error: null })));
        return () => {};
      }
      if (inputCount + inputs.length > 128)
        throw new RangeError("Too many visible action checks");
      const copy = structuredClone(inputs);
      const watcher: Watcher = { inputs: copy, entries: [], listener };
      for (const input of copy) {
        const identity = key(input);
        let entry = entries.get(identity);
        if (!entry) {
          entry = {
            input,
            watchers: new Set(),
            version: 0,
            pending: false,
            dueAt: performance.now(),
          };
          entries.set(identity, entry);
        }
        entry.watchers.add(watcher);
        watcher.entries.push(entry);
      }
      inputCount += copy.length;
      watchers.add(watcher);
      emit([watcher]);
      run();
      return () => {
        if (!watchers.delete(watcher)) return;
        inputCount -= copy.length;
        for (const entry of watcher.entries) entry.watchers.delete(watcher);
        run();
      };
    },
  };
}
