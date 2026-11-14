import { useEffect, useSyncExternalStore } from "react";
import type { TextEncoding } from "@serial-workbench/contracts";
import {
  encodingBackendStatus,
  prepareTextEncoding,
  subscribeEncodingBackend,
} from "@/lib/text-encoding";

export function useTextEncoding(encoding: TextEncoding) {
  const status = useSyncExternalStore(
    subscribeEncodingBackend,
    encodingBackendStatus,
    encodingBackendStatus,
  );
  useEffect(() => {
    void prepareTextEncoding(encoding).catch(() => {});
  }, [encoding]);
  return encoding === "utf-8"
    ? "ready"
    : status === "idle"
      ? "loading"
      : status;
}
