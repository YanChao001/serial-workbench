import {
  defaults,
  parseSharedSettings,
  type SharedSettings,
} from "@serial-workbench/contracts";
import { APP_CONFIG } from "@/config/app";
import { customAccentPalette, normalizeAccentColor } from "@/lib/accent-colors";
import { getLocale } from "@/i18n/registry";
import { isTauri } from "@/lib/tauri";
import {
  DEFAULT_CLIENT_PREFERENCES,
  parseClientPreferences,
  readInitialClientPreferences,
  type ClientPreferences,
} from "./client-settings";
export {
  DEFAULT_CLIENT_PREFERENCES,
  type ClientPreferences,
} from "./client-settings";
export { LANGUAGES, type Language } from "@/i18n/registry";
export { ACCENTS, type Accent } from "@/lib/accent-colors";
export {
  BACKGROUNDS,
  BACKGROUND_INTENSITIES,
  type BackgroundIntensity,
} from "@/lib/backgrounds";
export const RADII = ["sharp", "soft", "round"] as const;
export const FONTS = ["geist", "system", "serif", "mono"] as const;
export const FONT_SIZES = ["sm", "md", "lg"] as const;
export const MOTIONS = ["full", "reduced"] as const;
export const THEMES = ["light", "dark", "system"] as const;
export const WINDOW_POSITIONS = ["remember", "center"] as const;
export const NETWORK_MODES = ["system", "direct"] as const;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = DEFAULT_CLIENT_PREFERENCES.sidebarWidth;
export const SIDEBAR_COLLAPSED_WIDTH = 48;
export const SETTINGS_VERSION = "0.1";
export const STORAGE_KEY = `${APP_CONFIG.browserStorageNamespace}:preview-settings-v0`;
export const THEME_STORAGE_KEY = `${APP_CONFIG.browserStorageNamespace}:preview-theme-v0`;
export type Radius = SharedSettings["radius"];
export type Font = SharedSettings["font"];
export type FontSize = SharedSettings["fontSize"];
export type Motion = SharedSettings["motion"];
export type AppTheme = SharedSettings["theme"];
export type NetworkMode = SharedSettings["networkMode"];
export type WindowPosition = ClientPreferences["windowPosition"];
export type AppSettings = SharedSettings & ClientPreferences;
export const DEFAULT_SETTINGS: AppSettings = {
  ...defaults.settings,
  ...DEFAULT_CLIENT_PREFERENCES,
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw { code: "INVALID_DOCUMENT" };
}
export function clientPreferences(value: AppSettings): ClientPreferences {
  return {
    menuBar: value.menuBar,
    windowPosition: value.windowPosition,
    sidebarCollapsed: value.sidebarCollapsed,
    sidebarWidth: value.sidebarWidth,
  };
}
export function sharedSettings(value: AppSettings): SharedSettings {
  const {
    menuBar: _menuBar,
    windowPosition: _windowPosition,
    sidebarCollapsed: _sidebarCollapsed,
    sidebarWidth: _sidebarWidth,
    ...shared
  } = value;
  return parseSharedSettings(shared);
}
export function normalizeSettingsPatch(
  current: AppSettings,
  patch: Partial<AppSettings>,
): Partial<AppSettings> {
  if (!isRecord(patch)) invalid();
  const selected = { ...patch };
  if (selected.customAccent !== undefined)
    selected.customAccent =
      normalizeAccentColor(selected.customAccent) ?? invalid();
  if (selected.sidebarWidth !== undefined) {
    if (!Number.isFinite(selected.sidebarWidth)) invalid();
    selected.sidebarWidth = Math.round(
      Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, selected.sidebarWidth),
      ),
    );
  }
  const value = { ...current, ...selected };
  sharedSettings(value);
  parseClientPreferences(clientPreferences(value));
  return selected;
}
export function settingsDocument(settings: AppSettings) {
  return {
    formatVersion: SETTINGS_VERSION,
    value: sharedSettings(settings),
  };
}
function parsePreview(raw: unknown): SharedSettings {
  if (!isRecord(raw)) invalid();
  if (
    typeof raw.formatVersion === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(raw.formatVersion)
  ) {
    const [major, minor] = raw.formatVersion.split(".").map(BigInt);
    if (major! > 0n || minor! > 1n) throw { code: "FUTURE_FORMAT" };
  }
  if (
    raw.formatVersion !== SETTINGS_VERSION ||
    Object.keys(raw).length !== 2 ||
    !Object.hasOwn(raw, "value")
  )
    invalid();
  return parseSharedSettings(raw.value);
}
export function readInitialSettings(): {
  settings: AppSettings;
  error: string | null;
} {
  if (isTauri()) return { settings: DEFAULT_SETTINGS, error: null };
  const client = readInitialClientPreferences().preferences;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return {
      settings: {
        ...(raw === null ? defaults.settings : parsePreview(JSON.parse(raw))),
        ...client,
      },
      error: null,
    };
  } catch (error) {
    return {
      settings: { ...defaults.settings, ...client },
      error:
        isRecord(error) && error.code === "FUTURE_FORMAT"
          ? "FUTURE_FORMAT"
          : "INVALID_DOCUMENT",
    };
  }
}
export function loadSettings(): AppSettings {
  return readInitialSettings().settings;
}
export function applySettings(
  settings: AppSettings,
  { includeTheme = true }: { includeTheme?: boolean } = {},
) {
  const root = document.documentElement;
  // 首屏在 React 挂载前应用主题；运行时由 next-themes 统一提交，保留过渡旧帧。
  if (includeTheme) {
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "system" &&
        (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false));
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }
  for (const [name, value] of Object.entries({
    accent: settings.accent,
    radius: settings.radius,
    font: settings.font,
    fontSize: settings.fontSize,
    background:
      settings.background.kind === "preset"
        ? settings.background.value
        : settings.background.kind === "bundled"
          ? settings.background.id
          : "custom",
    backgroundIntensity: settings.backgroundIntensity,
    motion: settings.motion,
    language: settings.language,
  }))
    root.dataset[name] = String(value);
  const customAccent = customAccentPalette(settings.customAccent);
  root.style.setProperty("--custom-accent-light", customAccent.light);
  root.style.setProperty("--custom-accent-dark", customAccent.dark);
  root.style.setProperty(
    "--skin-exposure",
    String(settings.backgroundIntensity / 100),
  );
  root.lang = getLocale(settings.language).documentLang;
}
