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
  async function readState(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const snapshot = await wait(port.read(), signal);
    if (snapshot.formatVersion !== "0.1") throw new Error("FUTURE_FORMAT");
    return snapshot;
  }
  return {
    async read(signal?: AbortSignal): Promise<Record<string, string>> {
      return { ...(await readState(signal)).state.drafts };
    },
    async save(
      drafts: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        const base = await readState(signal);
        signal?.throwIfAborted();
        try {
          await wait(
            port.save({ ...base.state, drafts: { ...drafts } }, base.revision),
            signal,
          );
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
