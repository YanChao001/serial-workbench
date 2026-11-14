import type { ClientStateSnapshot, ClientWindowState } from "@/lib/tauri";
export type ClientDraftPort = {
  read(): Promise<ClientStateSnapshot>;
  save(
    state: ClientWindowState,
    expectedRevision: string,
  ): Promise<ClientStateSnapshot>;
};
export type ClientDraftStore = ReturnType<typeof createClientDraftStore>;
function wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
export function createClientDraftStore(port: ClientDraftPort) {
  let current: { revision: string; drafts: Record<string, string> } | undefined;
  let initialRead: Promise<Record<string, string>> | undefined;
  function remember(snapshot: ClientStateSnapshot) {
    if (!current || BigInt(snapshot.revision) >= BigInt(current.revision))
      current = {
        revision: snapshot.revision,
        drafts: { ...snapshot.state.drafts },
      };
    return { ...current.drafts };
  }
  async function readState(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const snapshot = await wait(port.read(), signal);
    if (snapshot.formatVersion !== "0.1") throw new Error("FUTURE_FORMAT");
    return snapshot;
  }
  return {
    getSnapshot(): Record<string, string> | undefined {
      return current && { ...current.drafts };
    },
    async read(signal?: AbortSignal): Promise<Record<string, string>> {
      signal?.throwIfAborted();
      if (current) return { ...current.drafts };
      if (!initialRead)
        initialRead = readState()
          .then(remember)
          .finally(() => {
            initialRead = undefined;
          });
      return { ...(await wait(initialRead, signal)) };
    },
    async save(
      drafts: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        const base = await readState(signal);
        signal?.throwIfAborted();
        try {
          // 取消等待不撤销已提交的保存；真实回执仍更新窗口缓存。
          const saved = port
            .save({ ...base.state, drafts: { ...drafts } }, base.revision)
            .then((snapshot) => {
              if (snapshot.formatVersion !== "0.1")
                throw new Error("FUTURE_FORMAT");
              remember(snapshot);
            });
          await wait(saved, signal);
          return;
        } catch (error) {
          if (
            attempt >= 2 ||
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "CONFLICT"
          )
            throw error;
        }
      }
    },
  };
}
