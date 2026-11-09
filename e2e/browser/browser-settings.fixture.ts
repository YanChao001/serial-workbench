/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import appConfig from "../../app.config.json" with { type: "json" };
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import clientDefaults from "../../src/lib/generated/client-defaults.json" with { type: "json" };

export const previewSettingsKey = `${appConfig.browserStorageNamespace}:preview-settings-v0`;
export const clientStateKey = `${appConfig.browserStorageNamespace}:client-state-v0`;

/** Seed only the current browser stores; native persistence uses the IPC fixture. */
export async function seedBrowserSettings(
  page: Page,
  patch: Record<string, unknown> = {},
) {
  const shared: Record<string, unknown> = {
    ...defaults.settings,
    language: "en",
    theme: "light",
    motion: "reduced",
    background: { kind: "bundled", id: "bundled:001" },
  };
  for (const key of Object.keys(defaults.settings))
    if (Object.hasOwn(patch, key)) shared[key] = patch[key];
  if (typeof shared.background === "string")
    shared.background = shared.background.startsWith("bundled:")
      ? { kind: "bundled", id: shared.background }
      : { kind: "preset", value: shared.background };
  const preferences: Record<string, unknown> = {
    ...clientDefaults.preferences,
  };
  for (const key of Object.keys(preferences))
    if (Object.hasOwn(patch, key)) preferences[key] = patch[key];
  await page.addInitScript(
    ({ sharedKey, clientKey, shared, state }) => {
      if (!localStorage.getItem(sharedKey))
        localStorage.setItem(
          sharedKey,
          JSON.stringify({ formatVersion: "0.1", value: shared }),
        );
      if (!sessionStorage.getItem(clientKey))
        sessionStorage.setItem(
          clientKey,
          JSON.stringify({ formatVersion: "0.1", revision: "0", state }),
        );
    },
    {
      sharedKey: previewSettingsKey,
      clientKey: clientStateKey,
      shared,
      state: { ...clientDefaults, preferences },
    },
  );
}
