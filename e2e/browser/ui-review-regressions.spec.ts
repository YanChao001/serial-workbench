import { seedBrowserSettings } from "./browser-settings.fixture";
/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page, motion = "reduced") {
  await seedBrowserSettings(page, {
    motion,
    theme: "light",
    background: "plain",
  });
}

test("controlled dialogs and search cancellation restore the keyboard position", async ({
  page,
}) => {
  await seed(page);
  await page.goto("./#/settings");
  const reset = page.getByRole("button", {
    name: "Reset preferences",
    exact: true,
  });
  await reset.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reset).toBeFocused();

  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("theme");
  await search.press("ArrowDown");
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await search.fill("radius");
  await search.press("Enter");
  await expect(page.locator("#settings-radius")).toBeFocused();
});
