import type {
  ClientPreferences,
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
  ClientWindowState_Serialize as ClientWindowState,
  ClientWindowState_Deserialize as ClientWindowStateInput,
  GalleryEntry,
  ConnectionDefault,
} from "./generated/bindings";
import {
  parseObjectRef,
  parseSerialConfiguration,
} from "@serial-workbench/contracts";
import type { SettingsBackend } from "./settings-sync";
import { settingsErrorCode } from "./settings-sync";
import generatedClientDefaults from "./generated/client-defaults.json";
import { APP_CONFIG } from "@/config/app";
import { isTauri, readClientState, saveClientState } from "./tauri";

export type {
  ClientPreferences,
  ClientWindowState_Serialize as ClientWindowState,
  ClientWindowState_Deserialize as ClientWindowStateInput,
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
} from "./generated/bindings";
export const DEFAULT_CLIENT_STATE = parseClientWindowState(
  generatedClientDefaults,
);
export const DEFAULT_CLIENT_PREFERENCES = DEFAULT_CLIENT_STATE.preferences;
export const BROWSER_CLIENT_STATE_KEY = `${APP_CONFIG.browserStorageNamespace}:client-state-v0`;

export function browserClientStateStore() {
  return createBrowserClientStateStore(
    sessionStorage,
    BROWSER_CLIENT_STATE_KEY,
    DEFAULT_CLIENT_STATE,
  );
}
export async function readClientWindowState(): Promise<ClientStateSnapshot> {
  return isTauri() ? readClientState() : browserClientStateStore().read();
}
export async function saveClientWindowState(
  state: ClientWindowStateInput,
  expectedRevision: string,
): Promise<ClientStateSnapshot> {
  return isTauri()
    ? saveClientState(state, expectedRevision)
    : browserClientStateStore().save(state, expectedRevision);
}
export function readInitialClientPreferences(): {
  preferences: ClientPreferences;
  error: string | null;
} {
  if (isTauri())
    return { preferences: DEFAULT_CLIENT_PREFERENCES, error: null };
  try {
    return {
      preferences: browserClientStateStore().read().state.preferences,
      error: null,
    };
  } catch (error) {
    return {
      preferences: DEFAULT_CLIENT_PREFERENCES,
      error: settingsErrorCode(error),
    };
  }
}
export type ClientSettingsPort = {
  read(): Promise<ClientStateSnapshot>;
  save(
    value: ClientWindowState,
    revision: string,
  ): Promise<ClientStateSnapshot>;
};
/** Updates the preferences slice while preserving all unsubmitted instance state. */
export function createClientSettingsBackend(
  port: ClientSettingsPort,
): SettingsBackend<ClientPreferences> {
  let current: ClientStateSnapshot | undefined;
  const accept = (snapshot: ClientStateSnapshot) => {
    if (snapshot.formatVersion !== "0.1") throw { code: "FUTURE_FORMAT" };
    current = snapshot;
    return { revision: snapshot.revision, value: snapshot.state.preferences };
  };
  return {
    async read() {
      return accept(await port.read());
    },
    async save(preferences, revision) {
      if (!current || current.revision !== revision) throw { code: "CONFLICT" };
      const original = current;
      let base = original;
      for (let attempt = 0; ; attempt++) {
        try {
          return accept(
            await port.save({ ...base.state, preferences }, base.revision),
          );
        } catch (error) {
          if (settingsErrorCode(error) !== "CONFLICT" || attempt === 2)
            throw error;
          const fresh = await port.read();
          if (fresh.formatVersion !== "0.1") throw { code: "FUTURE_FORMAT" };
          const keys = Object.keys(original.state.preferences) as Array<
            keyof ClientPreferences
          >;
          // 草稿/图库也推进窗口 revision；只合并偏好未变化的其他切片更新。
          if (
            keys.some(
              (key) =>
                fresh.state.preferences[key] !==
                original.state.preferences[key],
            )
          )
            throw error;
          base = fresh;
        }
      }
    },
    async subscribe() {
      return () => {};
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalidClient(): never {
  throw { code: "STORAGE_CORRUPT" };
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
) {
  return (
    Object.keys(value).every(
      (key) => keys.includes(key) || optional.includes(key),
    ) && keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parseConnectionDefaults(value: unknown): ConnectionDefault[] {
  if (!Array.isArray(value) || value.length > 128) invalidClient();
  const targets = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["hostId", "deviceId", "configuration"])
    )
      invalidClient();
    try {
      const target = parseObjectRef({
        hostId: entry.hostId,
        kind: "device",
        id: entry.deviceId,
      });
      const configuration = parseSerialConfiguration(entry.configuration);
      const key = JSON.stringify([target.hostId, target.id]);
      if (targets.has(key)) invalidClient();
      targets.add(key);
      return { hostId: target.hostId, deviceId: target.id, configuration };
    } catch {
      invalidClient();
    }
  });
}
export function parseClientPreferences(value: unknown): ClientPreferences {
  if (
    !record(value) ||
    !exactKeys(value, [
      "menuBar",
      "windowPosition",
      "sidebarCollapsed",
      "sidebarWidth",
    ]) ||
    typeof value.menuBar !== "boolean" ||
    typeof value.sidebarCollapsed !== "boolean" ||
    (value.windowPosition !== "remember" &&
      value.windowPosition !== "center") ||
    typeof value.sidebarWidth !== "number" ||
    !Number.isInteger(value.sidebarWidth) ||
    value.sidebarWidth < 180 ||
    value.sidebarWidth > 360
  )
    invalidClient();
  return {
    menuBar: value.menuBar,
    windowPosition: value.windowPosition,
    sidebarCollapsed: value.sidebarCollapsed,
    sidebarWidth: value.sidebarWidth,
  };
}
function parseClientGallery(value: unknown): GalleryEntry[] {
  if (!Array.isArray(value) || value.length > 24) invalidClient();
  const identities = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["reference", "name"]) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      Array.from(entry.name).length > 120 ||
      /\p{Cc}/u.test(entry.name)
    )
      invalidClient();
    let reference: ReturnType<typeof parseObjectRef>;
    try {
      reference = parseObjectRef(entry.reference);
    } catch {
      invalidClient();
    }
    if (reference.kind !== "file" || reference.revision === undefined)
      invalidClient();
    revision(reference.revision);
    const identity = JSON.stringify([reference.hostId, reference.id]);
    if (identities.has(identity)) invalidClient();
    identities.add(identity);
    return { reference, name: entry.name };
  });
}
export function parseClientWindowState(value: unknown): ClientWindowState {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "preferences",
        "currentPage",
        "focusedPanelId",
        "scrollOffset",
        "follow",
        "lastWorkspaceId",
        "drafts",
        "gallery",
      ],
      ["connectionDefaults"],
    ) ||
    typeof value.currentPage !== "string" ||
    !["workbench", "settings", "diagnostics", "recovery"].includes(
      value.currentPage,
    ) ||
    (value.focusedPanelId !== null &&
      (typeof value.focusedPanelId !== "string" ||
        ![
          "devices",
          "terminal",
          "send",
          "capture",
          "tasks",
          "activity",
        ].includes(value.focusedPanelId))) ||
    typeof value.scrollOffset !== "number" ||
    !Number.isInteger(value.scrollOffset) ||
    value.scrollOffset < 0 ||
    value.scrollOffset > 4294967295 ||
    typeof value.follow !== "boolean" ||
    (value.lastWorkspaceId !== null &&
      typeof value.lastWorkspaceId !== "string") ||
    !record(value.drafts)
  )
    invalidClient();
  if (
    value.lastWorkspaceId !== null &&
    (value.lastWorkspaceId.includes("\0") ||
      new TextEncoder().encode(value.lastWorkspaceId).length > 128)
  )
    invalidClient();
  if (Object.keys(value.drafts).length > 128) invalidClient();
  const drafts: Record<string, string> = {};
  for (const [key, draft] of Object.entries(value.drafts)) {
    if (
      !key ||
      /\p{Cc}/u.test(key) ||
      new TextEncoder().encode(key).length > 128 ||
      typeof draft !== "string" ||
      draft.includes("\0") ||
      new TextEncoder().encode(draft).length > 65536
    )
      invalidClient();
    Object.defineProperty(drafts, key, {
      value: draft,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    preferences: parseClientPreferences(value.preferences),
    currentPage: value.currentPage,
    focusedPanelId: value.focusedPanelId,
    scrollOffset: value.scrollOffset,
    follow: value.follow,
    lastWorkspaceId: value.lastWorkspaceId,
    drafts,
    gallery: parseClientGallery(value.gallery),
    ...(Object.hasOwn(value, "connectionDefaults")
      ? {
          connectionDefaults: parseConnectionDefaults(value.connectionDefaults),
        }
      : {}),
  };
}
function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    invalidClient();
  return value;
}
/** Browser windows keep independent client state; shared preview settings use another store. */
export function createBrowserClientStateStore(
  storage: Storage,
  key: string,
  initial: ClientWindowState,
) {
  function read(): ClientStateSnapshot {
    const raw = storage.getItem(key);
    if (raw === null)
      return {
        formatVersion: "0.1",
        revision: "0",
        state: parseClientWindowState(initial),
      };
    if (new TextEncoder().encode(raw).length > 512 * 1024) invalidClient();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      invalidClient();
    }
    if (
      !record(value) ||
      !exactKeys(value, ["formatVersion", "revision", "state"]) ||
      value.formatVersion !== "0.1"
    )
      invalidClient();
    return {
      formatVersion: "0.1",
      revision: revision(value.revision),
      state: parseClientWindowState(value.state),
    };
  }
  return {
    read,
    save(
      state: ClientWindowStateInput,
      expectedRevision: string,
    ): ClientStateSnapshot {
      const current = read();
      if (current.revision !== expectedRevision) throw { code: "CONFLICT" };
      const next = {
        formatVersion: "0.1",
        revision: revision(String(BigInt(current.revision) + 1n)),
        state: parseClientWindowState({
          ...state,
          gallery: state.gallery ?? [],
        }),
      };
      const json = JSON.stringify(next);
      if (new TextEncoder().encode(json).length > 512 * 1024)
        throw { code: "INPUT_TOO_LONG" };
      storage.setItem(key, json);
      return next;
    },
  };
}
