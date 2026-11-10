import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SettingsContext,
  type SettingsContextValue,
} from "@/providers/settings-context";
import { DEFAULT_SETTINGS } from "@/lib/settings-model";
import { I18nContext } from "@/providers/i18n-context";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/en";
import { clearUserLog, getUserLog, recordUserLog } from "@/lib/user-log";
import { WorkbenchLogPanel } from "./workbench-log-panel";
afterEach(() => {
  cleanup();
  clearUserLog();
});

it("keeps retry in the current module's log details after the transient notification is gone", async () => {
  recordUserLog(
    {
      module: "serial",
      level: "error",
      message: "Parameters were not saved",
      code: "STORAGE_UNAVAILABLE",
    },
    "serial-save",
  );
  const settings: SettingsContextValue = {
    settings: DEFAULT_SETTINGS,
    update: vi.fn(),
    reset: vi.fn(),
    persistence: "error",
    persistenceError: "STORAGE_UNAVAILABLE",
    persistenceScope: "serial",
    retrySave: vi.fn(),
  };
  const content = (current: SettingsContextValue) => (
    <I18nContext value={{ language: "en", t: createTranslator(en) }}>
      <SettingsContext value={current}>
        <WorkbenchLogPanel />
      </SettingsContext>
    </I18nContext>
  );
  const view = render(content(settings));
  fireEvent.click(screen.getByRole("button", { name: en["common.details"] }));
  const retry = await screen.findByRole("button", { name: en["common.retry"] });
  fireEvent.click(retry);
  expect(settings.retrySave).toHaveBeenCalledOnce();
  view.rerender(
    content({ ...settings, persistence: "saved", persistenceError: null }),
  );
  expect(screen.queryByRole("button", { name: en["common.retry"] })).toBeNull();
});

it("keeps module, local time and repeated fault counts readable while codes stay in copyable details", async () => {
  const fault = {
    module: "serial",
    level: "error",
    message: "Cannot open port",
    code: "ACCESS_DENIED",
    context: "COM14",
  } as const;
  recordUserLog(fault, "first");
  recordUserLog(fault, "second");
  render(
    <I18nContext value={{ language: "en", t: createTranslator(en) }}>
      <WorkbenchLogPanel />
    </I18nContext>,
  );
  const log = screen.getByRole("log");
  expect(within(log).getByText("Serial port")).toBeVisible();
  expect(within(log).getByLabelText("Occurrences")).toHaveTextContent("×2");
  expect(log).not.toHaveTextContent("ACCESS_DENIED");
  fireEvent.click(
    within(log).getByRole("button", { name: en["common.details"] }),
  );
  const details = await screen.findByRole("textbox", { name: "Log details" });
  expect(details).toHaveProperty(
    "value",
    expect.stringContaining("Error code: ACCESS_DENIED"),
  );
  expect(details).toHaveProperty(
    "value",
    expect.stringContaining("Occurrences: 2"),
  );
  fireEvent.keyDown(details, { key: "Escape" });
  fireEvent.click(
    screen.getByRole("button", { name: "Clear this window’s log" }),
  );
  expect(getUserLog()).toHaveLength(0);
});
