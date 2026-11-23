import { appConfig } from "./json-fixtures";
import { seedBrowserSettings } from "./browser-settings.fixture";
/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";

const SETTINGS_KEY = `${appConfig.browserStorageNamespace}:preview-settings-v0`;
const browserFailures = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy|violates.*directive/i.test(message.text())
    )
      failures.push(message.text());
  });
  await seedBrowserSettings(page);
});

test.afterEach(async ({ page }, testInfo) => {
  const failures = browserFailures.get(page) ?? [];
  if (failures.length)
    await testInfo.attach("browser-runtime-or-asset-errors", {
      body: JSON.stringify(failures, null, 2),
      contentType: "application/json",
    });
  expect(failures).toEqual([]);
});

test("the empty workspace and HashRouter load below the product subpath", async ({
  page,
}) => {
  await page.goto("./#/");
  await expect(page.getByTestId("serial-workbench-shell")).toBeAttached();
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main h1")).toHaveText("Serial Workbench");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toBeEditable();
  await draft.fill("offline draft");
  await expect(draft).toHaveValue("offline draft");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("tab")).toHaveCount(0);
  const sidebar = page.locator("#app-sidebar-navigation");
  await expect(sidebar.getByRole("link")).toHaveCount(2);
  await expect(
    page.locator(".app-sidebar-tools").getByRole("link", {
      name: "Settings",
      exact: true,
    }),
  ).toBeVisible();
  await expect(sidebar.locator('a[href="#/diagnostics"]')).toHaveCount(0);
  await expect(sidebar.locator('a[href="#/recovery"]')).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Plugins", exact: true }).click();
  await expect(page).toHaveURL(/\/serial-workbench\/#\/plugins$/);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install plugin" }),
  ).toHaveCount(0);
  await page.goto("./#/settings");
  await page.reload();
  await expect(page).toHaveURL(/\/serial-workbench\/#\/settings$/);
  await expect(page.locator("#settings-theme")).toBeVisible();
});

test("theme and language preferences survive a real browser reload", async ({
  page,
}) => {
  await page.goto("./#/settings");
  await page
    .locator("#settings-theme")
    .getByRole("button", { name: "Dark", exact: true })
    .click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .locator("#settings-language")
    .getByRole("combobox", { name: "Language", exact: true })
    .click();
  await page.locator('[role="option"][lang="zh-CN"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw
          ? (JSON.parse(raw).value as { theme: string; language: string })
          : null;
      }, SETTINGS_KEY),
    )
    .toMatchObject({ theme: "dark", language: "zh" });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("keyboard opens the command palette and restores trigger focus", async ({
  page,
}) => {
  await page.goto("./#/settings");
  const trigger = page
    .locator(".app-title-bar")
    .getByRole("button", { name: "Quick actions", exact: true });
  await trigger.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("shortcut edits reject conflicts and survive a reload", async ({
  page,
}) => {
  await page.goto("./#/settings");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const change = help.getByRole("button", {
    name: "Change shortcut for Quick actions",
  });
  await change.click();
  const capture = help.getByRole("textbox", {
    name: "Change shortcut for Quick actions",
  });
  await expect(capture).toBeFocused();
  const save = help.getByRole("button", { name: "Save", exact: true });
  await capture.press("Control+b");
  await expect(help.getByRole("status")).toContainText("Already used by");
  await expect(save).toBeDisabled();
  await capture.press("Control+Shift+y");
  await expect(capture).toHaveValue("Ctrl+Shift+Y");
  await save.click();
  await expect(change).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+y");
  const palette = page.getByRole("dialog", { name: "Quick actions" });
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.keyboard.press("Control+Shift+y");
  await expect(palette.getByRole("combobox")).toBeFocused();
});

test("F1 opens keyboard shortcut help from a focused control", async ({
  page,
}) => {
  await page.goto("./#/settings");
  const trigger = page
    .locator(".app-title-bar")
    .getByRole("button", { name: "Quick actions", exact: true });
  await trigger.focus();
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const search = dialog.getByRole("searchbox", {
    name: "Search keyboard shortcuts",
  });
  await expect(search).toBeFocused();
  await search.fill("enter hex");
  await expect(dialog.getByText("Send draft")).toBeVisible();
  await expect(
    dialog.getByText("Send editor in Text or HEX mode"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
