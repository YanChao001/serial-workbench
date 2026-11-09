import { defaults } from "@serial-workbench/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySettings,
  DEFAULT_SETTINGS,
  normalizeSettingsPatch,
  readInitialSettings,
  settingsDocument,
  sharedSettings,
  STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./settings-model";
import * as desktop from "./tauri";
import {
  browserClientStateStore,
  DEFAULT_CLIENT_STATE,
} from "./client-settings";
vi.mock("./tauri", () => ({ isTauri: vi.fn(() => false) }));

describe("Host defaults and isolated preview settings", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(desktop.isTauri).mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());
  it("builds every shared default directly from the Rust export", () => {
    expect(sharedSettings(DEFAULT_SETTINGS)).toEqual(defaults.settings);
  });
  it("never reads or migrates the retired v7 document or theme key", () => {
    localStorage.setItem(
      "serial-workbench:settings",
      JSON.stringify({ schemaVersion: 7, theme: "light", language: "en" }),
    );
    localStorage.setItem("serial-workbench:theme", "light");
    expect(readInitialSettings().settings).toEqual(DEFAULT_SETTINGS);
    expect(STORAGE_KEY).not.toBe("serial-workbench:settings");
    expect(THEME_STORAGE_KEY).not.toBe("serial-workbench:theme");
  });
  it("keeps shared and client values separate in a versioned preview document", () => {
    const value = {
      ...DEFAULT_SETTINGS,
      theme: "light" as const,
      sidebarWidth: 300,
      windowPosition: "center" as const,
    };
    const document = settingsDocument(value);
    expect(document).toMatchObject({
      formatVersion: "0.1",
      value: { theme: "light" },
    });
    expect(document).not.toHaveProperty("client");
    expect(document.value).not.toHaveProperty("sidebarWidth");
    expect(document.value).not.toHaveProperty("windowPosition");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
    browserClientStateStore().save(
      {
        ...DEFAULT_CLIENT_STATE,
        preferences: {
          ...DEFAULT_CLIENT_STATE.preferences,
          sidebarWidth: 300,
          windowPosition: "center",
        },
      },
      "0",
    );
    expect(readInitialSettings()).toEqual({ settings: value, error: null });
  });
  it.each([
    ['{"formatVersion":"0.2","value":{}}', "FUTURE_FORMAT"],
    ['{"formatVersion":"0.1",', "INVALID_DOCUMENT"],
    [
      JSON.stringify({ ...settingsDocument(DEFAULT_SETTINGS), unknown: true }),
      "INVALID_DOCUMENT",
    ],
    [
      JSON.stringify({
        ...settingsDocument(DEFAULT_SETTINGS),
        value: { ...defaults.settings, injected: true },
      }),
      "INVALID_DOCUMENT",
    ],
    [
      JSON.stringify({
        ...settingsDocument(DEFAULT_SETTINGS),
        client: { menuBar: "false" },
      }),
      "INVALID_DOCUMENT",
    ],
  ])("preserves unreadable preview bytes %s", (raw, code) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(readInitialSettings()).toEqual({
      settings: DEFAULT_SETTINGS,
      error: code,
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });
  it("does not use preview settings or browser credentials on desktop startup", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(settingsDocument({ ...DEFAULT_SETTINGS, theme: "light" })),
    );
    vi.mocked(desktop.isTauri).mockReturnValue(true);
    expect(readInitialSettings()).toEqual({
      settings: DEFAULT_SETTINGS,
      error: null,
    });
  });
  it("normalizes explicit UI edits without copying unknown fields into either store", () => {
    expect(
      normalizeSettingsPatch(DEFAULT_SETTINGS, {
        customAccent: " #abc ",
        sidebarWidth: 999,
      }),
    ).toEqual({ customAccent: "#AABBCC", sidebarWidth: 360 });
    expect(() =>
      normalizeSettingsPatch(DEFAULT_SETTINGS, {
        theme: "invalid",
      } as unknown as Parameters<typeof normalizeSettingsPatch>[1]),
    ).toThrow();
    expect(() =>
      normalizeSettingsPatch(DEFAULT_SETTINGS, {
        credentials: "secret",
      } as unknown as Parameters<typeof normalizeSettingsPatch>[1]),
    ).toThrow();
  });
  it("still applies language, theme, font, accent and motion to the document", () => {
    applySettings({
      ...DEFAULT_SETTINGS,
      language: "en",
      theme: "light",
      font: "mono",
      accent: "custom",
      customAccent: "#123ABC",
      motion: "reduced",
    });
    const root = document.documentElement;
    expect(root.lang).toBe("en");
    expect(root).toHaveClass("light");
    expect(root.dataset.font).toBe("mono");
    expect(root.dataset.motion).toBe("reduced");
    expect(root.style.getPropertyValue("--custom-accent-light")).toBe(
      "#123ABC",
    );
  });
});
