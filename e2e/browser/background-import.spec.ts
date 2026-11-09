/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedBrowserSettings } from "./browser-settings.fixture";
import {
  chooseFixtureMedia,
  colorMedia,
  seedMediaFixture,
} from "./media.fixture";

test("browser preview preserves wallpaper controls and reports that native media is unavailable", async ({
  page,
}) => {
  await seedBrowserSettings(page);
  await page.goto("./#/settings");
  await expect(
    page.getByRole("button", { name: "Add wallpapers", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Media backgrounds are not connected yet. Your selection is preserved.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.locator("img[data-bundled-wallpaper]")).toBeVisible();
});

test("a native media selection stores references and renders the resolved image across a reload", async ({
  page,
}, testInfo) => {
  await seedMediaFixture(page);
  await page.goto("./#/settings");
  const reference = await chooseFixtureMedia(
    page,
    await colorMedia(page, "sky.png", "#94bddc"),
  );
  const image = page.locator("[data-custom-background]");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(320);
  await expect(
    page.getByRole("button", { name: "Use wallpaper: sky.png", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.workbenchFixture.settingsWrites.at(-1)?.background,
      ),
    )
    .toEqual({ kind: "media", reference, fit: "cover" });
  await page
    .getByRole("radio", { name: "Show full image", exact: true })
    .click();
  await expect(image).toHaveCSS("object-fit", "contain");
  await page.reload();
  await expect(image).toHaveCSS("object-fit", "contain");
  await expect(
    page.getByRole("button", { name: "Use wallpaper: sky.png", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const snapshot = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("workbench-native-fixture")!),
  );
  expect(snapshot.client.state.gallery).toEqual([
    { name: "sky.png", reference },
  ]);
  expect(snapshot.settings.document.value.background).toEqual({
    kind: "media",
    reference,
    fit: "contain",
  });
  expect(JSON.stringify(snapshot.settings)).not.toMatch(
    /data:image|blob:|__fixture-media/,
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("native-image.png") });
});
