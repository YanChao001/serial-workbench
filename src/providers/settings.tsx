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
import { SettingsContext, type SettingsContextValue } from "./settings-context";
import { useConnectionPreferences } from "./use-connection-preferences";
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
import type { HostConnection } from "@/lib/host-client";
import { nodeThemeKey, useNodeThemes } from "./use-node-themes";
import { browserHostClientId } from "@/lib/browser-host-page";
import { createMediaPort, type MediaPort } from "@/lib/media";
import { reportClientError } from "@/lib/report-error";
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
  const hostBacked = native || browserHostClientId() !== undefined;
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
  const connections = useConnectionPreferences();
  const retryConnections = connections.retry;
  const [initialClient] = useState(readInitialClientPreferences);
  const [settings, setSettings] = useState(initial.settings);
  const [sharedPersistence, setPersistence] = useState<PersistenceStatus>(
    initial.error ? "error" : hostBacked ? "loading" : "saved",
  );
  const [sharedError, setPersistenceError] = useState(initial.error);
  const [sharedErrorEventKey, setSharedErrorEventKey] = useState<string>();
  const [clientState, setClientState] = useState<{
    status: PersistenceStatus;
    error: string | null;
  }>({
    status: initialClient.error ? "error" : "loading",
    error: initialClient.error,
  });
  const [committed, setCommitted] = useState<{
    connection: HostConnection;
    revision: string;
    themeKey?: string;
  }>();
  const localSettings =
    committed?.connection === connection ? committed : undefined;
  const committedRevision = localSettings?.revision;
  const supportsNodeThemes = host?.state.catalog?.some(
    (action) => action.actionId === "node.themes.list",
  );
  const themes = useNodeThemes(
    hostBacked && supportsNodeThemes ? connection : undefined,
  );
  const nodeThemes = hostBacked ? themes : undefined;
  const themeKey = localSettings?.themeKey;
  const nodeAccent = themes.find(
    (theme) => nodeThemeKey(theme) === themeKey,
  )?.accent;
  const [effectsError, setEffectsError] = useState<string | null>(null);
  const [effectsRetry, setEffectsRetry] = useState(0);
  const [effectsCompleted, setEffectsCompleted] = useState<{
    connection: HostConnection;
    revision: string;
    retry: number;
  } | null>(null);
  const effectsPending =
    native &&
    connection &&
    committedRevision !== undefined &&
    (effectsCompleted?.connection !== connection ||
      effectsCompleted?.revision !== committedRevision ||
      effectsCompleted?.retry !== effectsRetry);
  const attachmentError =
    hostBacked && !connection && host?.state.status === "error"
      ? settingsErrorCode(host.state.error)
      : null;
  const persistenceError =
    attachmentError ??
    sharedError ??
    clientState.error ??
    connections.error ??
    effectsError;
  const persistenceScope = attachmentError
    ? "connection"
    : sharedError
      ? "shared"
      : clientState.error
        ? "client"
        : connections.error
          ? "serial"
          : effectsError
            ? "effects"
            : undefined;
  const persistence: PersistenceStatus = persistenceError
    ? "error"
    : (hostBacked && !connection) ||
        sharedPersistence === "loading" ||
        clientState.status === "loading" ||
        connections.status === "loading"
      ? "loading"
      : sharedPersistence === "saving" ||
          clientState.status === "saving" ||
          connections.status === "saving" ||
          effectsPending
        ? "saving"
        : "saved";
  const persistenceEventKey =
    persistenceScope === "shared" ? sharedErrorEventKey : undefined;
  useEffect(() => {
    if (!native) return;
    for (const [scope, code] of [
      ["attachment", attachmentError],
      ["shared", sharedError],
      ["client", clientState.error],
      ["effects", effectsError],
    ] as const) {
      if (code) reportClientError(new Error(code), `Settings ${scope}`);
    }
  }, [native, attachmentError, sharedError, clientState.error, effectsError]);
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
      setSharedErrorEventKey(undefined);
      previewPending.current = {};
      return true;
    } catch {
      setPersistence("error");
      setPersistenceError("STORAGE_UNAVAILABLE");
      setSharedErrorEventKey(undefined);
      return false;
    }
  }, []);
  useEffect(() => {
    applySettings(settings, { includeTheme: false, nodeAccent });
  }, [settings, nodeAccent]);
  useEffect(() => {
    if (!hostBacked) savePreview(current.current);
  }, [hostBacked, savePreview]);
  useEffect(() => {
    if (!hostBacked || !connection) return;
    const backend = createHostSettingsBackend(connection);
    sharedBackend.current = backend;
    const coordinator = new SettingsSync(
      sharedSettings(current.current),
      backend,
      (state) => {
        publish({ ...state.settings, ...clientPreferences(current.current) });
        setPersistence(state.status);
        setPersistenceError(state.error);
        setSharedErrorEventKey(state.errorEventKey);
        const { revision } = state;
        setCommitted((previous) => {
          if (revision === undefined) return undefined;
          const sameConnection = previous?.connection === connection;
          // The overlay follows a saved selection instead of an optimistic edit.
          const themeKey =
            state.status === "saved"
              ? state.settings.nodeTheme &&
                nodeThemeKey(state.settings.nodeTheme)
              : sameConnection
                ? previous.themeKey
                : undefined;
          return sameConnection &&
            previous.revision === revision &&
            previous.themeKey === themeKey
            ? previous
            : { connection, revision, themeKey };
        });
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
  }, [connection, hostBacked, publish]);
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
        setEffectsCompleted({
          connection,
          revision: committedRevision,
          retry: effectsRetry,
        });
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
        receiveHistory,
        ...shared
      } = normalized;
      if (
        menuBar !== undefined ||
        windowPosition !== undefined ||
        sidebarCollapsed !== undefined ||
        sidebarWidth !== undefined ||
        receiveHistory !== undefined
      ) {
        const patch = {
          ...(menuBar !== undefined ? { menuBar } : {}),
          ...(windowPosition !== undefined ? { windowPosition } : {}),
          ...(sidebarCollapsed !== undefined ? { sidebarCollapsed } : {}),
          ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
          ...(receiveHistory !== undefined ? { receiveHistory } : {}),
        };
        if (clientSync.current) clientSync.current.update(patch);
        else {
          unsavedClient.current = { ...unsavedClient.current, ...patch };
          publish({ ...current.current, ...patch });
        }
      }
      if (Object.keys(shared).length) {
        if (!hostBacked) {
          previewPending.current = { ...previewPending.current, ...shared };
          publish({ ...current.current, ...shared });
          savePreview(current.current);
        } else if (sync.current) {
          if (native) sharedBackend.current?.markExplicitEdit();
          sync.current.update(shared);
        } else {
          unsaved.current = { ...unsaved.current, ...shared };
          publish(next);
        }
      }
    },
    [hostBacked, native, publish, savePreview],
  );
  const reset = useCallback(async () => {
    if (!hostBacked) {
      if (blockedPreview.current || clientState.error)
        throw { code: persistenceError ?? "INVALID_DOCUMENT" };
      const next = {
        ...defaults.settings,
        language: current.current.language,
        ...DEFAULT_CLIENT_PREFERENCES,
      };
      if (!savePreview(next)) throw { code: "STORAGE_UNAVAILABLE" };
      publish({
        ...current.current,
        nodeTheme: undefined,
        ...sharedSettings(next),
      });
      if (!clientSync.current) throw { code: "STORAGE_UNAVAILABLE" };
      await clientSync.current.replace(DEFAULT_CLIENT_PREFERENCES);
      return;
    }
    if (!sync.current || !clientSync.current)
      throw { code: "HOST_UNAVAILABLE" };
    if (persistenceError) throw { code: persistenceError };
    if (native) sharedBackend.current?.markExplicitEdit();
    await Promise.all([
      sync.current.replace({
        ...defaults.settings,
        language: current.current.language,
        nodeTheme: undefined,
      }),
      clientSync.current.replace(DEFAULT_CLIENT_PREFERENCES),
    ]);
  }, [
    hostBacked,
    native,
    persistenceError,
    clientState.error,
    publish,
    savePreview,
  ]);
  const retrySave = useCallback(() => {
    void retryConnections();
    if (clientSync.current) void clientSync.current.retry();
    if (hostBacked) {
      if (sync.current) {
        if (native) sharedBackend.current?.markExplicitEdit();
        void sync.current.retry();
      } else
        void host?.refresh().catch((error) => {
          setPersistence("error");
          setPersistenceError(settingsErrorCode(error));
          setSharedErrorEventKey(undefined);
        });
      if (native) setEffectsRetry((value) => value + 1);
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
  }, [host, hostBacked, native, publish, savePreview, retryConnections]);
  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      update,
      reset,
      persistence,
      persistenceError,
      persistenceEventKey,
      persistenceScope,
      retrySave,
      media,
      connections,
      nodeThemes,
    }),
    [
      settings,
      update,
      reset,
      persistence,
      persistenceError,
      persistenceEventKey,
      persistenceScope,
      retrySave,
      media,
      connections,
      nodeThemes,
    ],
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
