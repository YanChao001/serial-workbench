import type { ObjectRef } from "@serial-workbench/contracts";
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

export function createMediaPort(native: MediaNativePort): MediaPort {
  return {
    async choose(signal) {
      signal?.throwIfAborted();
      const selected = await native.choose();
      signal?.throwIfAborted();
      return selected;
    },
    async resolve(reference, signal) {
      signal?.throwIfAborted();
      const media = await native.resolve(reference);
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
