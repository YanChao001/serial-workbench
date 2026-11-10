/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

const runtimeFailures = new WeakMap<Page, string[]>();
const consoleRecords = new WeakMap<Page, { type: string; text: string }[]>();
test.beforeEach(async ({ page }) => {
  consoleRecords.set(page, []);
  const failures: string[] = [];
  runtimeFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    consoleRecords
      .get(page)
      ?.push({ type: message.type(), text: message.text() });
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const failures = runtimeFailures.get(page) ?? [];
  const fixture = await page.evaluate(() => window.workbenchFixture);
  const record = testInfo.outputPath("runtime-and-ipc.json");
  await writeFile(
    record,
    JSON.stringify(
      { failures, console: consoleRecords.get(page) ?? [], fixture },
      null,
      2,
    ),
  );
  await testInfo.attach("runtime-and-ipc", {
    path: record,
    contentType: "application/json",
  });
  expect(failures).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
});

async function expectSenderReachable(page: Page, enabled: boolean) {
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(draft).toBeEditable();
  await expect(page.locator(".workbench-draft-frame")).toBeInViewport({
    ratio: 1,
  });
  await expect(draft).toBeInViewport({ ratio: 1 });
  await expect(send).toBeInViewport({ ratio: 1 });
  if (enabled) {
    await expect(send).toBeEnabled();
    // A trial click checks hit testing without submitting another operation.
    await send.click({ trial: true });
  } else await expect(send).toBeDisabled();
  const layout = await page.locator("main").evaluate((main) => ({
    mainWidth: main.clientWidth,
    mainScrollWidth: main.scrollWidth,
    mainHeight: main.clientHeight,
    mainScrollHeight: main.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: innerWidth,
    scrollTop: document.scrollingElement?.scrollTop,
  }));
  expect(layout.mainScrollWidth).toBeLessThanOrEqual(layout.mainWidth + 1);
  expect(layout.mainScrollHeight).toBeLessThanOrEqual(layout.mainHeight + 1);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.scrollTop).toBe(0);
}

async function connect(page: Page) {
  const open = page.getByRole("button", {
    name: "Open Virtual serial",
    exact: true,
  });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
}

test("default terminal keeps byte columns aligned on the send surface", async ({
  page,
}, testInfo) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toBeEditable();
  const widths = await draft.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Canvas text measurement is unavailable");
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      family: style.fontFamily,
      size: style.fontSize,
      narrow: context.measureText("iiiiiiii").width,
      wide: context.measureText("WWWWWWWW").width,
    };
  });
  expect(widths.narrow).toBeGreaterThan(0);
  expect(Math.abs(widths.narrow - widths.wide)).toBeLessThan(0.05);
  await writeFile(
    testInfo.outputPath("terminal-font-metrics.json"),
    JSON.stringify(
      {
        ...widths,
        userAgent: await page.evaluate(() => navigator.userAgent),
        viewport: page.viewportSize(),
      },
      null,
      2,
    ),
  );
});

test("send byte information stays passive while draft conversion preserves the desktop layout", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  await connect(page);
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const geometry = () =>
    page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        toolbar: rect(".workbench-compose-toolbar"),
        draft: rect(".workbench-draft-frame"),
        send: rect(".workbench-send-button"),
        receive: rect(".workbench-stream-log"),
      };
    });
  const initial = await geometry();
  await draft.fill("哈哈创森散地");
  await expect(page.locator(".workbench-compose-toolbar")).not.toContainText(
    "E5 93 88",
  );
  const bytes = page.locator(".workbench-draft-bytes");
  await expect(bytes).toHaveText("18 bytes");
  await expect(bytes).not.toHaveAttribute("tabindex");
  await expect(
    page.locator(".workbench-preview-trigger,.workbench-byte-preview"),
  ).toHaveCount(0);
  await draft.fill("哈哈创森散地".repeat(80));
  expect(await geometry()).toEqual(initial);
  const sender = page.getByRole("region", { name: "Send", exact: true });
  await sender.getByRole("radio", { name: "HEX", exact: true }).click();
  await expect(draft).toHaveValue(
    Array(80)
      .fill("E5 93 88 E5 93 88 E5 88 9B E6 A3 AE E6 95 A3 E5 9C B0")
      .join(" "),
  );
  await expect(bytes).toHaveText("1440 bytes");
  expect(await geometry()).toEqual(initial);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await sender.getByRole("radio", { name: "Text", exact: true }).click();
  await expect(draft).toHaveValue("哈哈创森散地".repeat(80));
  await draft.focus();
  await expect(draft).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Receipt", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual([
    Buffer.from("哈哈创森散地".repeat(80)).toString("base64"),
  ]);
  expect(await geometry()).toEqual(initial);
  await page.screenshot({
    path: testInfo.outputPath("fixed-send-toolbar.png"),
  });
  const receipt = testInfo.outputPath("send-layout.json");
  await writeFile(
    receipt,
    JSON.stringify({ initial, final: await geometry() }, null, 2),
  );
  await testInfo.attach("send-layout", {
    path: receipt,
    contentType: "application/json",
  });
});

for (const method of ["Delete", "close button"] as const) {
  test(`closing the last view by ${method} returns keyboard focus to the device choice`, async ({
    page,
  }) => {
    await seedWorkbenchFixture(page, {});
    await page.goto("./#/");
    await connect(page);
    const tab = page.getByRole("tab");
    await expect(tab).toHaveCount(1);
    if (method === "Delete") await tab.press("Delete");
    else {
      const close = page.getByRole("button", {
        name: "Close view",
        exact: true,
      });
      await close.focus();
      await page.keyboard.press("Enter");
    }
    await expect(tab).toHaveCount(0);
    const device = page.getByRole("combobox", {
      name: "Choose device",
      exact: true,
    });
    await expect(device).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
  });
}

for (const language of ["en", "zh"] as const) {
  test(`live byte presentation keeps receipts and exact time available in ${language}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, { language });
    await page.goto("./#/");
    await page.getByRole("button", { name: /Virtual serial$/ }).click();
    await expect(
      page.getByRole("button", {
        name: language === "en" ? "Close session" : "关闭会话",
        exact: true,
      }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBe(1);
    await page.locator(".workbench-draft").fill("STATUS?");
    await page
      .getByRole("button", {
        name: language === "en" ? "Send" : "发送",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: language === "en" ? "Receipt" : "回执",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("status", {
        name: language === "en" ? "Receipt" : "回执",
        exact: true,
      }),
    ).toContainText(language === "en" ? "Completed" : "已完成");
    await page.keyboard.press("Escape");
    const items: unknown[] = workbenchStreamItems();
    expect(
      await page.evaluate(
        (items) => window.workbenchFixture.emitRaw(items),
        items,
      ),
    ).toBe(1);
    const log = page.getByRole("log");
    await expect(log.locator('[data-direction="tx"]')).toHaveCount(1);
    await expect(log.locator('[data-direction="rx"]')).toHaveCount(1);
    await expect(log).toContainText("STATUS?");
    await expect(log).toContainText("OK");
    await page.screenshot({
      path: testInfo.outputPath(`stream-${language}-compact.png`),
      animations: "disabled",
    });
    const receipt = log.locator(".workbench-tx-receipt > details");
    await expect(receipt.locator("summary")).toHaveText(
      language === "en" ? "Accepted by backend" : "后端已接受",
    );
    await expect(receipt.locator(".workbench-tx-facts")).toBeHidden();
    await receipt.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(receipt.locator(".workbench-tx-facts")).toBeVisible();
    await expect(receipt).toContainText("[0, 7)");
    await expect(receipt).toContainText(
      language === "en"
        ? "No device acknowledgement provided"
        : "设备确认未提供",
    );
    const time = log.locator(".workbench-stream-time").first();
    await expect(time.locator("summary")).toHaveText("11:22:33.456Z");
    await time.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(time.locator("time")).toBeVisible();
    await expect(time.locator("time")).toHaveText("2026-11-10T11:22:33.456Z");
    await page.screenshot({
      path: testInfo.outputPath(`stream-${language}-details.png`),
      animations: "disabled",
    });
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1120, height: 744 },
    { width: 880, height: 600 },
  ]) {
    for (const sidebarCollapsed of [false, true]) {
      test(`sender stays reachable with a high transparency image: ${theme}, ${viewport.width}x${viewport.height}, sidebar ${sidebarCollapsed ? "collapsed" : "expanded"}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await seedWorkbenchFixture(page, { theme, sidebarCollapsed });
        await page.goto("./#/");
        await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
        await expect(page.locator("html")).toHaveAttribute(
          "data-background-intensity",
          "90",
        );
        const wallpaper = page.locator("img[data-bundled-wallpaper]");
        await expect(wallpaper).toBeVisible();
        await wallpaper.evaluate((image: HTMLImageElement) => image.decode());
        await expect(page.locator(".app-sidebar")).toHaveAttribute(
          "data-collapsed",
          String(sidebarCollapsed),
        );
        await expectSenderReachable(page, false);
        const parameters = page.getByRole("button", {
          name: "Connection parameters",
          exact: true,
        });
        await parameters.focus();
        await expect(parameters).toHaveAccessibleDescription(/9600 \/ 8N1/);
        await expect(page.getByRole("tab")).toHaveCount(0);
        await page
          .getByRole("textbox", { name: "Send draft", exact: true })
          .fill("Unsaved offline draft");
        await expectSenderReachable(page, false);
        await page.screenshot({
          path: testInfo.outputPath("unconnected.png"),
          animations: "disabled",
        });
        expect(
          await page.evaluate(() => window.workbenchFixture.connectCalls),
        ).toEqual([]);
        await connect(page);
        expect(
          await page.evaluate(() => window.workbenchFixture.connectCalls),
        ).toEqual(["device"]);
        await page
          .getByRole("textbox", { name: "Send draft", exact: true })
          .fill("STATUS?");
        await expectSenderReachable(page, true);
        await parameters.focus();
        await expect(parameters).toHaveAccessibleDescription(/115200 \/ 8N1/);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page
          .getByRole("button", { name: "Receipt", exact: true })
          .click();
        await expect(
          page.getByRole("status", { name: "Receipt", exact: true }),
        ).toContainText("Completed");
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("status", { name: "Receipt", exact: true }),
        ).toHaveCount(0);
        await expectSenderReachable(page, true);
        await page.screenshot({
          path: testInfo.outputPath("connected.png"),
          animations: "disabled",
        });
        const toggle = page.getByRole("button", {
          name: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
          exact: true,
        });
        await toggle.click();
        await expect(page.locator(".app-sidebar")).toHaveAttribute(
          "data-collapsed",
          String(!sidebarCollapsed),
        );
        await expectSenderReachable(page, true);
        expect(
          await page.evaluate(() => window.workbenchFixture.sentBytes),
        ).toEqual(["U1RBVFVTPw=="]);
      });
    }
  }
}

async function keyboardOpenAndClose(
  page: Page,
  trigger: Locator,
  popup: Locator,
) {
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await expect
    .poll(() =>
      popup.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
}

test("keyboard tool dialogs, display popover and palette preserve focus without moving the sender", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, { theme: "light" });
  await page.goto("./#/");
  await expect(
    page.getByRole("button", { name: "Open Virtual serial", exact: true }),
  ).toBeEnabled();
  await keyboardOpenAndClose(
    page,
    page.getByRole("button", { name: /^Connection parameters/ }),
    page.getByRole("dialog", { name: "Connection parameters", exact: true }),
  );
  await keyboardOpenAndClose(
    page,
    page.getByRole("button", { name: "Workspace", exact: true }),
    page.getByRole("dialog", { name: "Workspace", exact: true }),
  );
  await keyboardOpenAndClose(
    page,
    page.getByRole("button", { name: "Display options", exact: true }),
    page.locator('[data-slot="popover-content"]'),
  );
  const quick = page
    .locator(".app-title-bar")
    .getByRole("button", { name: "Quick actions", exact: true });
  await quick.focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog").getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(quick).toBeFocused();
  await expectSenderReachable(page, false);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await testInfo.attach("accessibility", {
    body: JSON.stringify(scan.violations, null, 2),
    contentType: "application/json",
  });
  expect(scan.violations).toEqual([]);
});

test("Chinese workbench exposes the approved device and sender labels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, { theme: "dark", language: "zh" });
  await page.goto("./#/");
  await expect(page.locator("main h1")).toHaveText(
    "\u4e32\u53e3\u5de5\u4f5c\u53f0",
  );
  await expect(
    page.getByRole("button", { name: /^\u8fde\u63a5\u53c2\u6570/ }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", {
      name: "\u53d1\u9001\u8349\u7a3f",
      exact: true,
    }),
  ).toBeEditable();
  await expect(
    page.getByRole("button", { name: "\u53d1\u9001", exact: true }),
  ).toBeDisabled();
  const parameters = page.getByRole("button", {
    name: "连接参数",
    exact: true,
  });
  await parameters.focus();
  await expect(parameters).toHaveAccessibleDescription(/9600 \/ 8N1/);
  await page.screenshot({
    path: testInfo.outputPath("chinese-unconnected.png"),
  });
});
