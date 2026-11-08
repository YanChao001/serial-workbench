/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedWorkbenchFixture } from "./workbench.fixture";

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
        await expect(
          page.getByRole("button", { name: /^Connection parameters/ }),
        ).toHaveAccessibleName(/^Connection parameters.*9600 \/ 8 none$/);
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
        await expect(
          page.getByRole("button", { name: /^Connection parameters/ }),
        ).toHaveAccessibleName(/^Connection parameters.*115200 \/ 8 none$/);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(
          page.getByRole("status", { name: "Receipt", exact: true }),
        ).toContainText("succeeded");
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
  await expect(
    page.getByRole("button", { name: /^\u8fde\u63a5\u53c2\u6570/ }),
  ).toHaveAccessibleName(/9600 \/ 8 none$/);
  await page.screenshot({
    path: testInfo.outputPath("chinese-unconnected.png"),
  });
});
