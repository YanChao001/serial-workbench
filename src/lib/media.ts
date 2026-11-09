import type { ObjectRef } from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { MediaResolution, SelectedFileResource } from "./tauri";

export type SelectedMedia = SelectedFileResource;

export interface ResolvedMedia extends Omit<MediaResolution, "ticket"> {
  dispose(): void;
}

export interface MediaPort {
  choose(signal?: AbortSignal): Promise<SelectedMedia | null>;
  resolve(reference: ObjectRef, signal?: AbortSignal): Promise<ResolvedMedia>;
}

export interface MediaNativePort {
  choose(): Promise<SelectedMedia | null>;
  resolve(reference: ObjectRef): Promise<MediaResolution>;
  release(ticket: string): Promise<void>;
}

function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createMediaPort(native: MediaNativePort): MediaPort {
  return {
    async choose(signal) {
      signal?.throwIfAborted();
      const selected = await native.choose();
      signal?.throwIfAborted();
      return selected;
    },
    async resolve(reference, signal) {
      let media: MediaResolution;
      let recoveries = 0;
      let busyRetries = 0;
      for (;;) {
        signal?.throwIfAborted();
        try {
          media = await native.resolve(reference);
          break;
        } catch (error: unknown) {
          signal?.throwIfAborted();
          // 并发明确保存会更新授权代次；仅以新读取重新验权，不重新选择或授权。
          if (!(error instanceof HostRequestError)) throw error;
          if (error.code === "PERMISSION_DENIED" && recoveries < 3) {
            recoveries++;
            continue;
          }
          // 背景与缩略图共享单个解码预算；退避不改变 Native 的并发和内存上限。
          if (error.code === "HOST_BUSY" && busyRetries < 5) {
            await retryDelay(Math.min(100 * 2 ** busyRetries++, 1000), signal);
            continue;
          }
          throw error;
        }
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        signal?.removeEventListener("abort", dispose);
        // Revocation is idempotent; a disconnected generation already invalidates it.
        void native.release(media.ticket).catch(() => undefined);
      };
      if (signal?.aborted) {
        dispose();
        signal.throwIfAborted();
      }
      signal?.addEventListener("abort", dispose, { once: true });
      return { url: media.url, name: media.name, mime: media.mime, dispose };
    },
  };
}
