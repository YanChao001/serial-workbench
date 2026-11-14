/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { zhCN } from "../../src/i18n/zh-CN";
import { en } from "../../src/i18n/en";
import { workbenchStreamItems } from "./workbench-stream.fixture";

for (const sample of [
  {
    language: "zh",
    theme: "dark",
    width: 1400,
    height: 925,
    message: "Subscription ended; request a new snapshot",
  },
  {
    language: "en",
    theme: "light",
    width: 880,
    height: 600,
    message:
      "Subscription ended; request a new snapshot\n" + "detail_".repeat(1000),
  },
] as const)
  test(`stream error details keep the notification frame fixed (${sample.language}/${sample.theme})`, async ({
    page,
  }, info) => {
    const messages = sample.language === "zh" ? zhCN : en;
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, sample);
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${messages["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBeGreaterThan(0);
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      workbenchStreamItems() as unknown[],
    );
    const draft = page.getByRole("textbox", {
      name: messages["workbench.draft"],
      exact: true,
    });
    await draft.fill("unsent local draft");
    await expect
      .poll(() =>
        page.evaluate(
          (message) =>
            window.workbenchFixture.endRaw({
              code: "CURSOR_EXPIRED",
              message,
              retryable: false,
            }),
          sample.message,
        ),
      )
      .toBeGreaterThan(0);
    const notice = page.locator("[data-sonner-toast]").filter({
      hasText: messages["workbench.streamUnavailable"],
    });
    await expect(notice).toBeVisible();
    await notice.hover();
    await page.waitForTimeout(450);
    const before = await notice.boundingBox();
    const trigger = notice.getByText(messages["workbench.errorDetails"], {
      exact: true,
    });
    if (sample.language === "zh") await trigger.press("Enter");
    else await trigger.click();
    await page.waitForTimeout(200);
    const after = await notice.boundingBox();
    await page.screenshot({
      path: info.outputPath("stream-error-details.png"),
    });
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
    const details = page.getByRole("region", {
      name: messages["workbench.errorDetails"],
      exact: true,
    });
    await expect(details).toHaveText(sample.message);
    await expect(details).toBeFocused();
    const panel = page.getByRole("dialog", {
      name: messages["workbench.errorDetails"],
      exact: true,
    });
    const panelBox = await panel.boundingBox();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(after!.y);
    expect(
      Math.abs(panelBox!.x + panelBox!.width - (after!.x + after!.width)),
    ).toBeLessThanOrEqual(2);
    expect(after!.y - (panelBox!.y + panelBox!.height)).toBeLessThanOrEqual(12);
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(sample.width);
    // 接收区/发送区改高会移动通知；详情必须随真实容器更新定位。
    const gapBefore = after!.y - (panelBox!.y + panelBox!.height);
    await page.evaluate(() => {
      const root = document.documentElement;
      const bottom =
        getComputedStyle(root)
          .getPropertyValue("--workbench-toast-bottom")
          .trim() || "24px";
      root.style.setProperty(
        "--workbench-toast-bottom",
        `calc(${bottom} + 40px)`,
      );
    });
    await expect
      .poll(async () => {
        const anchor = await notice.boundingBox();
        const moved = await panel.boundingBox();
        return Math.abs(anchor!.y - (moved!.y + moved!.height) - gapBefore);
      })
      .toBeLessThanOrEqual(1);
    const movedNotice = await notice.boundingBox();
    expect(after!.y - movedNotice!.y).toBeGreaterThan(30);
    const geometry = await details.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    if (sample.language === "en") {
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      await details.hover();
      await page.waitForTimeout(5500);
      await expect(details).toBeVisible();
    }
    await expect(draft).toHaveValue("unsent local draft");
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(
      notice.getByRole("button", {
        name: messages["workbench.errorDetails"],
        exact: true,
      }),
    ).toBeFocused();
  });

for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 880, height: 600 },
] as const)
  test(`connection notification stays anchored through hover and diagnostics opens recovery (${sample.language}/${sample.theme})`, async ({
    page,
  }, info) => {
    const messages = sample.language === "zh" ? zhCN : en;
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, {
      language: sample.language,
      theme: sample.theme,
      motion: "full",
      connectFailure: {
        code: "ACCESS_DENIED",
        message: "Fixture cannot open port",
        retryable: false,
      },
      hostFailure: {
        code: "UNAUTHENTICATED",
        message: "EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
        retryable: false,
      },
    });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${messages["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.failHost()))
      .toBeGreaterThan(0);
    const notice = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: messages["workbench.hostUnavailable"] });
    await expect(notice).toBeVisible();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
    await expect(notice.locator("details")).toHaveCount(0);
    await expect(
      notice.getByText("UNAUTHENTICATED", { exact: true }),
    ).toBeVisible();
    await notice.hover();
    await page.waitForTimeout(250);
    const hovered = await notice.boundingBox();
    await page.mouse.move(24, 80);
    await page.waitForTimeout(250);
    const resting = await notice.boundingBox();
    await notice.hover();
    await page.waitForTimeout(250);
    const returned = await notice.boundingBox();
    const toastBoxes = await page
      .locator("[data-sonner-toast]")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => ({
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
          }))
          .sort((a, b) => a.top - b.top),
      );
    await page.screenshot({
      path: info.outputPath("connection-notice-before-or-after.png"),
    });
    await info.attach("hover-geometry", {
      body: JSON.stringify({ hovered, resting, returned }, null, 2),
      contentType: "application/json",
    });
    expect(Math.abs(hovered!.y - resting!.y)).toBeLessThan(1);
    expect(Math.abs(returned!.y - resting!.y)).toBeLessThan(1);
    expect(toastBoxes[0]!.bottom).toBeLessThan(toastBoxes[1]!.top);
    const composer = await page
      .getByRole("region", { name: messages["workbench.send"], exact: true })
      .boundingBox();
    expect(returned!.y + returned!.height).toBeLessThanOrEqual(composer!.y);
    await notice
      .getByRole("link", { name: messages["shell.diagnostics"], exact: true })
      .click();
    await expect(page).toHaveURL(/#\/settings\?focus=recovery$/);
    const recovery = page.locator("#settings-recovery");
    await expect(recovery).toBeFocused();
    await expect(recovery.locator(":scope > legend")).toBeInViewport({
      ratio: 1,
    });
    expect(await page.locator("body").innerText()).not.toMatch(
      /EXPLICIT_FIXTURE_SECRET|C:\/private\/fixture-user/,
    );
  });

test("connection diagnostics navigates to and focuses the recovery section", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    hostStart: "failed",
    hostFailure: {
      code: "UNAUTHENTICATED",
      message: "EXPLICIT_FIXTURE_SECRET",
      retryable: false,
    },
  });
  await page.goto("./#/");
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: zhCN["workbench.hostUnavailable"] });
  await expect(notice).toBeVisible();
  await expect(
    notice.getByText(zhCN["nativeError.unauthenticated"]),
  ).toBeVisible();
  await notice
    .getByRole("link", { name: zhCN["shell.diagnostics"], exact: true })
    .click();
  await expect(page).toHaveURL(/#\/settings\?focus=recovery$/);
  await expect(page.locator("#settings-recovery")).toBeFocused();
});
