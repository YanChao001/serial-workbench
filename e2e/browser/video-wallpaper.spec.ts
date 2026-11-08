/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { seedMediaFixture, chooseFixtureMedia } from "./media.fixture";

async function openSettings(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await seedMediaFixture(page, { theme: "dark", motion: "full" });
  await page.goto("./#/settings");
}
async function videoFile(which: "first" | "second") {
  return {
    name: `${which}.webm`,
    mimeType: "video/webm",
    buffer: await readFile(
      new URL(`../fixtures/video-wallpaper-${which}.webm`, import.meta.url),
    ),
  };
}
const playing = (page: Page) =>
  page
    .locator("[data-custom-background-video]")
    .evaluate((node: HTMLVideoElement) => !node.paused);

test("native video references survive reload and playback follows motion and transparency", async ({
  page,
}, testInfo) => {
  await openSettings(page);
  const reference = await chooseFixtureMedia(page, await videoFile("first"));
  const video = page.locator("[data-custom-background-video]");
  await expect(video).toBeVisible();
  await expect.poll(() => playing(page)).toBe(true);
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(0);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Use wallpaper: first.webm",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => playing(page)).toBe(true);
  const slider = page.getByRole("slider", {
    name: "Background transparency",
    exact: true,
  });
  await slider.press("Home");
  await expect.poll(() => playing(page)).toBe(false);
  await slider.press("ArrowRight");
  await expect.poll(() => playing(page)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => playing(page)).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => playing(page)).toBe(true);
  const retained = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("workbench-native-fixture")!),
  );
  expect(retained.settings.document.value.background.reference).toEqual(
    reference,
  );
  expect(retained.client.state.gallery).toEqual([
    { reference, name: "first.webm" },
  ]);
  expect(JSON.stringify(retained.settings)).not.toMatch(
    /data:video|blob:|__fixture-media/,
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("native-video.png") });
});

test("distinct native video references select independently and deleting another library entry preserves the current resource", async ({
  page,
}) => {
  await openSettings(page);
  const first = await chooseFixtureMedia(page, await videoFile("first"));
  await expect.poll(() => playing(page)).toBe(true);
  const second = await chooseFixtureMedia(page, await videoFile("second"));
  const firstChoice = page.getByRole("button", {
    name: "Use wallpaper: first.webm",
    exact: true,
  });
  const secondChoice = page.getByRole("button", {
    name: "Use wallpaper: second.webm",
    exact: true,
  });
  await expect(secondChoice).toHaveAttribute("aria-pressed", "true");
  await firstChoice.click();
  await expect(firstChoice).toHaveAttribute("aria-pressed", "true");
  await expect(secondChoice).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Delete wallpaper: second.webm", exact: true })
    .click();
  await expect(secondChoice).toHaveCount(0);
  await expect.poll(() => playing(page)).toBe(true);
  const retained = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("workbench-native-fixture")!),
  );
  expect(retained.settings.document.value.background.reference).toEqual(first);
  expect(retained.settings.document.value.background.reference).not.toEqual(
    second,
  );
  expect(retained.client.state.gallery).toEqual([
    { reference: first, name: "first.webm" },
  ]);
});

test("changing away from a native video releases its resolved ticket and keeps reusable window gallery metadata", async ({
  page,
}) => {
  await openSettings(page);
  const reference = await chooseFixtureMedia(page, await videoFile("first"));
  await expect.poll(() => playing(page)).toBe(true);
  await page.locator('.skin-gallery label:has(input[value="plain"])').click();
  await expect(page.locator("[data-custom-background-video]")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.releasedMedia.length),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", {
      name: "Use wallpaper: first.webm",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Use wallpaper: first.webm", exact: true })
    .click();
  await expect.poll(() => playing(page)).toBe(true);
  expect(
    await page.evaluate(() => window.workbenchFixture.resolvedMedia),
  ).toEqual(expect.arrayContaining([reference]));
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
});
