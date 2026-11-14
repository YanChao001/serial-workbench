import type {
  SharedSettings,
  SettingsSnapshot,
  U64,
} from "@serial-workbench/contracts";
import { operationFailureEventKey } from "./operation-failure";
import { parseU64 } from "./u64";

export type PersistenceStatus = "loading" | "saving" | "saved" | "error";
export type SettingsState<T = SharedSettings> = {
  settings: T;
  revision: U64 | undefined;
  status: PersistenceStatus;
  error: string | null;
  errorEventKey?: string;
};
export type SettingsDocument<T> = Pick<SettingsSnapshot, "revision"> & {
  value: T;
};
export type SettingsBackend<T = SharedSettings> = {
  read(): Promise<SettingsDocument<T>>;
  save(value: T, expectedRevision: U64): Promise<SettingsDocument<T>>;
  subscribe(
    listener: (snapshot: SettingsDocument<T>) => void,
    failed?: (error: unknown) => void,
  ): Promise<() => void>;
};
export const settingsErrorCode = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "STORAGE_UNAVAILABLE";

/** Host owns the document; this client only retains unsaved field edits. */
export class SettingsSync<T extends object = SharedSettings> {
  private base: T;
  private pending: Partial<T> = {};
  private inFlight: Partial<T> = {};
  private revision: U64 | undefined;
  private stopped = false;
  private saving = false;
  private loading = false;
  private error: string | null = null;
  private errorEventKey: string | undefined;
  private initialization: Promise<void> | undefined;
  private unlisten: (() => void) | undefined;
  private subscriptionGeneration = 0;
  private completions = new Set<{
    resolve(): void;
    reject(error: { code: string }): void;
  }>();

  constructor(
    initial: T,
    private backend: SettingsBackend<T>,
    private changed: (state: SettingsState<T>) => void,
  ) {
    this.base = initial;
  }
  private settings(): T {
    return { ...this.base, ...this.inFlight, ...this.pending };
  }
  private emit() {
    if (this.stopped) return;
    const status: PersistenceStatus = this.error
      ? "error"
      : this.loading || this.revision === undefined
        ? "loading"
        : this.saving || Object.keys(this.pending).length
          ? "saving"
          : "saved";
    this.changed({
      settings: this.settings(),
      revision: this.revision,
      status,
      error: this.error,
      ...(this.errorEventKey ? { errorEventKey: this.errorEventKey } : {}),
    });
    if (status === "saved" || status === "error") {
      for (const completion of this.completions) {
        if (this.error) completion.reject({ code: this.error });
        else completion.resolve();
      }
      this.completions.clear();
    }
  }
  private fail(error: unknown) {
    this.error = settingsErrorCode(error);
    this.errorEventKey = operationFailureEventKey(error);
    this.emit();
  }
  private accept(snapshot: SettingsDocument<T>) {
    if (parseU64(snapshot.revision) === undefined)
      throw { code: "INVALID_DOCUMENT" };
    if (
      this.revision !== undefined &&
      BigInt(snapshot.revision) <= BigInt(this.revision)
    )
      return;
    this.revision = snapshot.revision;
    this.base = snapshot.value;
  }
  start(): Promise<void> {
    if (this.stopped || this.revision !== undefined) return Promise.resolve();
    return this.initialize();
  }
  private initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.loading = true;
    this.error = null;
    this.errorEventKey = undefined;
    this.emit();
    this.initialization = Promise.resolve()
      .then(async () => {
        if (this.stopped) return;
        try {
          if (!this.unlisten) {
            const generation = ++this.subscriptionGeneration;
            const failed = (error: unknown) => {
              if (this.stopped || generation !== this.subscriptionGeneration)
                return;
              this.subscriptionGeneration++;
              this.unlisten?.();
              this.unlisten = undefined;
              this.fail(error);
            };
            const stop = await this.backend.subscribe((snapshot) => {
              if (this.stopped || generation !== this.subscriptionGeneration)
                return;
              try {
                this.accept(snapshot);
                this.emit();
              } catch (error) {
                failed(error);
              }
            }, failed);
            if (this.stopped || generation !== this.subscriptionGeneration) {
              stop();
              return;
            }
            this.unlisten = stop;
          }
          const snapshot = await this.backend.read();
          if (this.stopped) return;
          this.accept(snapshot);
        } catch (error) {
          if (!this.stopped) this.fail(error);
        } finally {
          this.loading = false;
          this.emit();
        }
        await this.flush();
      })
      .finally(() => {
        this.initialization = undefined;
      });
    return this.initialization;
  }
  update(patch: Partial<T>) {
    if (this.stopped) return;
    this.pending = { ...this.pending, ...patch };
    this.emit();
    void this.flush();
  }
  whenSaved(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.stopped) return Promise.reject({ code: "STORAGE_UNAVAILABLE" });
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const completion = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error: { code: string }) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        this.completions.delete(completion);
        cleanup();
        reject(signal?.reason);
      };
      this.completions.add(completion);
      signal?.addEventListener("abort", abort, { once: true });
      this.emit();
    });
  }
  async retry() {
    if (this.stopped || this.saving) return;
    await this.initialize();
  }
  replace(value: T): Promise<void> {
    if (this.stopped) return Promise.reject({ code: "STORAGE_UNAVAILABLE" });
    if (this.error) return Promise.reject({ code: this.error });
    const completed = new Promise<void>((resolve, reject) => {
      this.completions.add({ resolve, reject });
    });
    this.update(value);
    return completed;
  }
  private async flush() {
    if (
      this.stopped ||
      this.loading ||
      this.saving ||
      this.error ||
      this.revision === undefined
    )
      return;
    this.saving = true;
    this.errorEventKey = undefined;
    try {
      while (!this.stopped && !this.error && Object.keys(this.pending).length) {
        this.inFlight = this.pending;
        this.pending = {};
        this.emit();
        try {
          const snapshot = await this.backend.save(
            this.settings(),
            this.revision,
          );
          if (this.stopped) return;
          this.accept(snapshot);
          this.inFlight = {};
        } catch (error) {
          this.pending = { ...this.inFlight, ...this.pending };
          this.inFlight = {};
          if (!this.stopped) this.fail(error);
        }
      }
    } finally {
      this.saving = false;
      this.emit();
    }
  }
  stop(): Partial<T> {
    this.stopped = true;
    this.unlisten?.();
    this.unlisten = undefined;
    for (const completion of this.completions)
      completion.reject({ code: "STORAGE_UNAVAILABLE" });
    this.completions.clear();
    return { ...this.inFlight, ...this.pending };
  }
}
