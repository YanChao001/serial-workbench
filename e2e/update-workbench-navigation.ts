import type { Page } from "@playwright/test";

/** Select the normal navigation link when the cached Workbench is hidden. */
export async function showUpgradeWorkbench(page: Page, timeout = 20_000) {
  const shell = page.getByTestId("serial-workbench-shell");
  if (!(await shell.isVisible())) {
    await page.locator('a[href="#/"]:visible').first().click({ timeout });
  }
  await shell.waitFor({ state: "visible", timeout });
}
