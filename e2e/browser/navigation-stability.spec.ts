/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import appConfig from "../../app.config.json" with { type: "json" };

test("reselecting settings preserves its controls and keyboard navigation keeps focus", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({ schemaVersion: 7, language: "en", motion: "reduced" }),
    );
  }, `${appConfig.browserStorageNamespace}:settings`);
  await page.goto("./#/settings");
  const theme = page.locator("#settings-theme");
  const original = (await theme.elementHandle())!;
  const sidebar = page.locator("#app-sidebar-navigation");
  const settings = page
    .locator(".app-sidebar-tools")
    .getByRole("link", { name: "Settings", exact: true });
  for (let repeat = 0; repeat < 3; repeat++) {
    await settings.click();
    expect(
      await theme.evaluate((element, node) => element === node, original),
    ).toBe(true);
    await settings.press("Enter");
    expect(
      await theme.evaluate((element, node) => element === node, original),
    ).toBe(true);
  }
  await sidebar.locator('a[href="#/extensions"]').focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/extensions$/);
  await expect(sidebar.locator('a[href="#/extensions"]')).toBeFocused();
  await expect(sidebar.locator('a[href="#/extensions"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  await sidebar.locator('a[href="#/"]').click();
  await expect(page.getByTestId("serial-workbench-shell")).toBeAttached();
  await expect(page.locator("main")).toBeVisible();
  await original.dispose();
});
