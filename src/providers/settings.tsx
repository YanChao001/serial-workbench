import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaults, type SharedSettings } from "@serial-workbench/contracts";
import { SettingsContext } from "./settings-context";
import { HostContext } from "./host-context";
import {
  applySettings,
  clientPreferences,
  DEFAULT_CLIENT_PREFERENCES,
  normalizeSettingsPatch,
  readInitialSettings,
  settingsDocument,
  sharedSettings,
  STORAGE_KEY,
  type AppSettings,
  type ClientPreferences,
} from "@/lib/settings-model";
import {
  SettingsSync,
  settingsErrorCode,
  type PersistenceStatus,
} from "@/lib/settings-sync";
import { createHostSettingsBackend } from "@/lib/host-settings";
import { createMediaPort, type MediaPort } from "@/lib/media";
import {
  isTauri,
  applyHostSettingsEffects,
  chooseFileResource,
  mediaResolve,
  mediaRelease,
} from "@/lib/tauri";
import {
  createClientSettingsBackend,
  readClientWindowState,
  saveClientWindowState,
  readInitialClientPreferences,
} from "@/lib/client-settings";
export * from "@/lib/settings-model";

export function SettingsProvider({
  children,
  media: injectedMedia,
}: {
  children: ReactNode;
  media?: MediaPort;
}) {
  const host = useContext(HostContext);
  const connection = host?.connection;
  const native = isTauri();
  const media = useMemo(
    () =>
      injectedMedia ??
      (native && connection
        ? createMediaPort({
            choose: () => chooseFileResource("media", connection.generation),
            resolve: (reference) =>
              mediaResolve(reference, connection.generation),
            release: (ticket) => mediaRelease(ticket, connection.generation),
          })
        : undefined),
    [injectedMedia, native, connection],
  );
  const [initial] = useState(readInitialSettings);
  const [initialClient] = useState(readInitialClientPreferences);
  const [settings, setSettings] = useState(initial.settings);
  const [sharedPersistence, setPersistence] = useState<PersistenceStatus>(
    initial.error ? "error" : native ? "loading" : "saved",
  );
  const [sharedError, setPersistenceError] = useState(initial.error);
  const [clientState, setClientState] = useState<{
    status: PersistenceStatus;
    error: string | null;
  }>({
    status: initialClient.error ? "error" : "loading",
    error: initialClient.error,
  });
  const [committedRevision, setCommittedRevision] = useState<string>();
  const [effectsError, setEffectsError] = useState<string | null>(null);
  const [effectsRetry, setEffectsRetry] = useState(0);
  const attachmentError =
    native && !connection && host?.state.status === "error"
      ? settingsErrorCode(host.state.error)
      : null;
  const persistenceError =
    attachmentError ?? sharedError ?? clientState.error ?? effectsError;
  const persistence: PersistenceStatus = persistenceError
    ? "error"
    : (native && !connection) ||
        sharedPersistence === "loading" ||
        clientState.status === "loading"
      ? "loading"
      : sharedPersistence === "saving" || clientState.status === "saving"
        ? "saving"
        : "saved";
  const current = useRef(settings);
  const sync = useRef<SettingsSync | null>(null);
  const sharedBackend = useRef<ReturnType<
    typeof createHostSettingsBackend
  > | null>(null);
  const clientSync = useRef<SettingsSync<ClientPreferences> | null>(null);
  const unsavedClient = useRef<Partial<ClientPreferences>>({});
  const unsaved = useRef<Partial<SharedSettings>>({});
  const previewPending = useRef<Partial<SharedSettings>>({});
  const blockedPreview = useRef(initial.error !== null);
  const publish = useCallback((next: AppSettings) => {
    current.current = next;
    setSettings(next);
  }, []);
  const savePreview = useCallback((next: AppSettings) => {
    if (blockedPreview.current) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsDocument(next)));
      setPersistence("saved");
      setPersistenceError(null);
      previewPending.current = {};
      return true;
    } catch {
      setPersistence("error");
      setPersistenceError("STORAGE_UNAVAILABLE");
      return false;
    }
  }, []);
  useEffect(() => {
    applySettings(settings, { includeTheme: false });
  }, [settings]);
  useEffect(() => {
    if (!native) savePreview(current.current);
  }, [native, savePreview]);
  useEffect(() => {
    if (!native || !connection) return;
    const backend = createHostSettingsBackend(connection);
    sharedBackend.current = backend;
    const coordinator = new SettingsSync(
      sharedSettings(current.current),
      backend,
      (state) => {
        publish({ ...state.settings, ...clientPreferences(current.current) });
        setPersistence(state.status);
        setPersistenceError(state.error);
        setCommittedRevision(state.revision);
      },
    );
    sync.current = coordinator;
    coordinator.update(unsaved.current);
    unsaved.current = {};
    void coordinator.start();
    return () => {
      unsaved.current = coordinator.stop();
      backend.dispose();
      sharedBackend.current = null;
      sync.current = null;
    };
  }, [connection, native, publish]);
  useEffect(() => {
    const coordinator = new SettingsSync(
      clientPreferences(current.current),
      createClientSettingsBackend({
        read: readClientWindowState,
        save: saveClientWindowState,
      }),
      (state) => {
        publish({ ...current.current, ...state.settings });
        setClientState({ status: state.status, error: state.error });
      },
    );
    clientSync.current = coordinator;
    coordinator.update(unsavedClient.current);
    unsavedClient.current = {};
    void coordinator.start();
    return () => {
      unsavedClient.current = coordinator.stop();
      clientSync.current = null;
    };
  }, [native, publish]);
  useEffect(() => {
    if (!native || !connection || committedRevision === undefined) return;
    let active = true;
    void applyHostSettingsEffects().then(
      (receipt) => {
        if (!active) return;
        if (
          receipt.hostId !== connection.attachment.hostId ||
          receipt.instanceEpoch !== connection.attachment.instanceEpoch ||
          BigInt(receipt.revision) < BigInt(committedRevision)
        ) {
          setEffectsError("HOST_EFFECTS_STALE");
          return;
        }
        setEffectsError(null);
      },
      (error) => {
        if (active) setEffectsError(settingsErrorCode(error));
      },
    );
    return () => {
      active = false;
    };
  }, [native, connection, committedRevision, effectsRetry]);
  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      const normalized = normalizeSettingsPatch(current.current, patch);
      const next = { ...current.current, ...normalized };
      const {
        menuBar,
        windowPosition,
        sidebarCollapsed,
        sidebarWidth,
        ...shared
      } = normalized;
      if (
        menuBar !== undefined ||
        windowPosition !== undefined ||
        sidebarCollapsed !== undefined ||
        sidebarWidth !== undefined
      ) {
        const patch = {
          ...(menuBar !== undefined ? { menuBar } : {}),
          ...(windowPosition !== undefined ? { windowPosition } : {}),
          ...(sidebarCollapsed !== undefined ? { sidebarCollapsed } : {}),
          ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
        };
        if (clientSync.current) clientSync.current.update(patch);
        else {
          unsavedClient.current = { ...unsavedClient.current, ...patch };
          publish({ ...current.current, ...patch });
        }
      }
      if (Object.keys(shared).length) {
        if (!native) {
          previewPending.current = { ...previewPending.current, ...shared };
          publish({ ...current.current, ...shared });
          savePreview(current.current);
        } else if (sync.current) {
          sharedBackend.current?.markExplicitEdit();
          sync.current.update(shared);
        } else {
          unsaved.current = { ...unsaved.current, ...shared };
          publish(next);
        }
      }
    },
    [native, publish, savePreview],
  );
  const reset = useCallback(async () => {
    if (!native) {
      if (blockedPreview.current || clientState.error)
        throw { code: persistenceError ?? "INVALID_DOCUMENT" };
      const next = {
        ...defaults.settings,
        language: current.current.language,
        ...DEFAULT_CLIENT_PREFERENCES,
      };
      if (!savePreview(next)) throw { code: "STORAGE_UNAVAILABLE" };
      publish({ ...current.current, ...sharedSettings(next) });
      if (!clientSync.current) throw { code: "STORAGE_UNAVAILABLE" };
      await clientSync.current.replace(DEFAULT_CLIENT_PREFERENCES);
      return;
    }
    if (!sync.current || !clientSync.current)
      throw { code: "HOST_UNAVAILABLE" };
    if (persistenceError) throw { code: persistenceError };
    sharedBackend.current?.markExplicitEdit();
    await Promise.all([
      sync.current.replace({
        ...defaults.settings,
        language: current.current.language,
      }),
      clientSync.current.replace(DEFAULT_CLIENT_PREFERENCES),
    ]);
  }, [native, persistenceError, clientState.error, publish, savePreview]);
  const retrySave = useCallback(() => {
    if (clientSync.current) void clientSync.current.retry();
    if (native) {
      if (sync.current) {
        sharedBackend.current?.markExplicitEdit();
        void sync.current.retry();
      } else
        void host?.refresh().catch((error) => {
          setPersistence("error");
          setPersistenceError(settingsErrorCode(error));
        });
      setEffectsRetry((value) => value + 1);
      return;
    }
    if (blockedPreview.current) {
      const loaded = readInitialSettings();
      if (loaded.error) {
        setPersistence("error");
        setPersistenceError(loaded.error);
        return;
      }
      blockedPreview.current = false;
      const next = { ...loaded.settings, ...previewPending.current };
      publish(next);
      savePreview(next);
    } else savePreview(current.current);
  }, [host, native, publish, savePreview]);
  const value = useMemo(
    () => ({
      settings,
      update,
      reset,
      persistence,
      persistenceError,
      retrySave,
      media,
    }),
    [settings, update, reset, persistence, persistenceError, retrySave, media],
  );
  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context)
    throw new Error("useSettings must be used within SettingsProvider");
  return context;
}
