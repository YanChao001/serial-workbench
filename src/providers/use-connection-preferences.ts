import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SerialConfiguration } from "@serial-workbench/contracts";
import {
  connectionKey,
  createConnectionDefaultsBackend,
  sameConnectionConfiguration,
  type ConnectionDefaults,
} from "@/lib/client-connection-defaults";
import {
  readClientWindowState,
  saveClientWindowState,
  type ClientSettingsPort,
} from "@/lib/client-settings";
import { SettingsSync, type SettingsState } from "@/lib/settings-sync";

const port: ClientSettingsPort = {
  read: readClientWindowState,
  save: saveClientWindowState,
};
export type ConnectionPreferences = ReturnType<typeof useConnectionPreferences>;
export function useConnectionPreferences(storage: ClientSettingsPort = port) {
  const [state, setState] = useState<SettingsState<ConnectionDefaults>>({
    settings: {},
    revision: undefined,
    status: "loading",
    error: null,
  });
  const latest = useRef(state);
  const pending = useRef<Partial<ConnectionDefaults>>({});
  const owner = useRef<SettingsSync<ConnectionDefaults> | null>(null);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const sync = new SettingsSync<ConnectionDefaults>(
      {},
      createConnectionDefaultsBackend(storage),
      (next) => {
        latest.current = next;
        if (next.status === "saved") setDirty(false);
        setState(next);
      },
    );
    owner.current = sync;
    sync.update(pending.current);
    pending.current = {};
    void sync.start();
    return () => {
      const remaining = sync.stop();
      if (owner.current === sync) {
        pending.current = remaining;
        owner.current = null;
      }
    };
  }, [storage, reload]);
  const remember = useCallback(
    (hostId: string, deviceId: string, configuration: SerialConfiguration) => {
      if (
        sameConnectionConfiguration(
          latest.current.settings[connectionKey(hostId, deviceId)],
          configuration,
        )
      )
        return;
      setDirty(true);
      const patch = { [connectionKey(hostId, deviceId)]: configuration };
      if (owner.current) owner.current.update(patch);
      else pending.current = { ...pending.current, ...patch };
    },
    [],
  );
  const retry = useCallback(async () => {
    await owner.current?.retry();
  }, []);
  const flush = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const sync = owner.current;
    if (!sync) throw { code: "STORAGE_UNAVAILABLE" };
    // 重试由同步器持有；界面只取消等待，不等待底层 I/O 后才接入取消。
    if (latest.current.status === "error")
      void sync.retry().catch(() => undefined);
    await sync.whenSaved(signal);
  }, []);
  const discard = useCallback(async (signal?: AbortSignal) => {
    const sync = owner.current;
    if (!sync) return;
    if (
      latest.current.status === "saving" ||
      latest.current.status === "loading"
    ) {
      try {
        await sync.whenSaved(signal);
      } catch {
        signal?.throwIfAborted();
      }
    }
    sync.stop();
    owner.current = null;
    pending.current = {};
    setDirty(false);
    setReload((value) => value + 1);
  }, []);
  return useMemo(
    () => ({
      values: state.settings,
      status: state.status,
      error: state.error,
      dirty,
      remember,
      retry,
      flush,
      discard,
    }),
    [
      state.settings,
      state.status,
      state.error,
      dirty,
      remember,
      retry,
      flush,
      discard,
    ],
  );
}
