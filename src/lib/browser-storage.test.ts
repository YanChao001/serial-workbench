import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readInitialSettings,
  DEFAULT_SETTINGS,
  settingsDocument,
  STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./settings-model";

vi.mock("@/config/app", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/config/app")>();
  return {
    ...original,
    APP_CONFIG: {
      ...original.APP_CONFIG,
      browserStorageNamespace: "com.example.migrated",
    },
  };
});
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));

describe("derived applications sharing a browser origin", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("does not inherit the template's preferences or shared legacy theme", () => {
    localStorage.setItem(
      "tauri-starter:settings",
      JSON.stringify({ accent: "rose", theme: "dark" }),
    );
    localStorage.setItem("theme", "light");
    expect(readInitialSettings().settings).toMatchObject({
      accent: "lime",
      theme: "dark",
    });

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        settingsDocument({
          ...DEFAULT_SETTINGS,
          accent: "blue",
          theme: "light",
        }),
      ),
    );
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readInitialSettings().settings).toMatchObject({
      accent: "blue",
      theme: "light",
    });
    expect(JSON.parse(localStorage.getItem("tauri-starter:settings")!)).toEqual(
      { accent: "rose", theme: "dark" },
    );
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("keeps the settings document authoritative over the namespaced theme cache", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(settingsDocument({ ...DEFAULT_SETTINGS, theme: "dark" })),
    );
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readInitialSettings().settings.theme).toBe("dark");
  });
});
