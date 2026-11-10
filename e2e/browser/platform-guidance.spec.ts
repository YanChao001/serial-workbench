/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

const records = new WeakMap<
  Page,
  { errors: string[]; console: { type: string; text: string }[] }
>();
test.beforeEach(async ({ page }) => {
  const record = {
    errors: [] as string[],
    console: [] as { type: string; text: string }[],
  };
  records.set(page, record);
  page.on("pageerror", (e) => record.errors.push(e.message));
  page.on("console", (m) => {
    record.console.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") record.errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.url().includes("/assets/") && r.status() >= 400)
      record.errors.push(`${r.status()} ${r.url()}`);
  });
});
test.afterEach(async ({ page }, info) => {
  const fixture = await page.evaluate(() => window.workbenchFixture);
  await writeFile(
    info.outputPath("runtime-and-ipc.json"),
    JSON.stringify({ ...records.get(page), fixture }, null, 2),
  );
  expect(records.get(page)?.errors).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
});
function texts(language: "en" | "zh") {
  const messages = language === "en" ? en : zhCN;
  return {
    open: language === "en" ? "Open Virtual serial" : "打开 Virtual serial",
    menu: messages["workbench.tools.more"],
    tool: messages["workbench.tools.diagnostics"],
    chooseDevice: messages["workbench.tools.chooseDevice"],
    refresh: messages["workbench.refresh"],
    details: messages["logs.details"],
    noIssues: messages["workbench.diagnostics.noIssues"],
    cause: messages["workbench.diagnostics.accessDenied"],
    guidance: {
      windows: [
        messages["workbench.tools.windowsRelease"],
        messages["workbench.tools.windowsDeviceManager"],
      ],
      macos: [
        messages["workbench.tools.macosRelease"],
        messages["workbench.tools.macosAccessory"],
      ],
      linux: [
        messages["workbench.tools.linuxPermissions"],
        messages["workbench.tools.linuxGroup"],
      ],
      web: [],
    },
  };
}

async function deviceQueries(page: Page) {
  return page.evaluate(() => ({
    catalog: window.workbenchFixture.hostQueries.filter(
      (query) => query === "catalog.list",
    ).length,
    devices: window.workbenchFixture.hostQueries.filter(
      (query) => query === "device.list",
    ).length,
    enumerations: window.workbenchFixture.hostQueries.filter(
      (query) => query === "device.refresh",
    ).length,
  }));
}

async function openDiagnostics(page: Page, text: ReturnType<typeof texts>) {
  const menu = page.getByRole("button", { name: text.menu, exact: true });
  await menu.focus();
  await menu.press("Enter");
  const item = page.getByRole("menuitem", { name: text.tool, exact: true });
  await item.focus();
  await item.press("Enter");
  const dialog = page.getByRole("dialog", { name: text.tool, exact: true });
  await expect(dialog).toBeVisible();
  return { menu, dialog };
}

async function recordLayoutAndAccessibility(
  page: Page,
  dialog: Locator,
  info: TestInfo,
) {
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      pageScroll: scrollY,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
  await writeFile(
    info.outputPath("diagnostic-geometry.json"),
    JSON.stringify(geometry, null, 2),
  );
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.pageScroll).toBe(0);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  await page.screenshot({ path: info.outputPath("diagnostic-880.png") });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await writeFile(
    info.outputPath("accessibility.json"),
    JSON.stringify(axe, null, 2),
  );
  expect(axe.violations).toEqual([]);
}

async function refreshFromDevicePicker(page: Page, chooseDevice: string) {
  const baseline = await deviceQueries(page);
  const operations = await page.evaluate(() => ({
    connections: window.workbenchFixture.connectCalls.length,
    invocations: window.workbenchFixture.invocations.length,
  }));
  const picker = page.getByRole("combobox", {
    name: chooseDevice,
    exact: true,
  });
  await picker.focus();
  await picker.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect
    .poll(() => deviceQueries(page))
    .toEqual({
      catalog: baseline.catalog + 1,
      devices: baseline.devices,
      enumerations: baseline.enumerations + 1,
    });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toBeFocused();
  expect(await deviceQueries(page)).toEqual({
    catalog: baseline.catalog + 1,
    devices: baseline.devices,
    enumerations: baseline.enumerations + 1,
  });
  expect(
    await page.evaluate(() => ({
      connections: window.workbenchFixture.connectCalls.length,
      invocations: window.workbenchFixture.invocations.length,
    })),
  ).toEqual(operations);
}

for (const language of ["en", "zh"] as const) {
  test(`healthy diagnostics stay quiet and device-picker opening refreshes in ${language}`, async ({
    page,
  }, info) => {
    const text = texts(language);
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, {
      language,
      theme: language === "en" ? "light" : "dark",
    });
    await page.goto("./#/");
    await page.getByRole("button", { name: text.open, exact: true }).click();
    // Wait for the separate metadata read after the confirmed Native open.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.hostQueries.filter(
              (q) => q === "device.list",
            ).length,
        ),
      )
      .toBeGreaterThanOrEqual(2);
    const baseline = await deviceQueries(page);
    const { menu, dialog } = await openDiagnostics(page, text);
    await expect(dialog).toContainText(text.noIssues);
    await expect(dialog.locator("summary, ol, a")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: text.details, exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: text.refresh, exact: true }),
    ).toHaveCount(0);
    for (const steps of Object.values(text.guidance))
      for (const step of steps) await expect(dialog).not.toContainText(step);
    expect(await deviceQueries(page)).toEqual(baseline);
    await recordLayoutAndAccessibility(page, dialog, info);
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();
    await refreshFromDevicePicker(page, text.chooseDevice);
  });

  test(`access-denied diagnostics select the current platform without inferring a cause in ${language}`, async ({
    page,
  }, info) => {
    const text = texts(language);
    const privateMessage = "EXPLICIT_FIXTURE_PRIVATE_CONNECTION_DETAIL";
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, {
      language,
      theme: language === "en" ? "light" : "dark",
      connectFailure: {
        code: "ACCESS_DENIED",
        message: privateMessage,
        retryable: false,
      },
    });
    await page.goto("./#/");
    await page.getByRole("button", { name: text.open, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.connectCalls))
      .toEqual(["device"]);
    const baseline = await deviceQueries(page);
    const { menu, dialog } = await openDiagnostics(page, text);
    await expect(dialog).toContainText(text.cause);
    await expect(dialog).toContainText(
      language === "en"
        ? "the current evidence does not identify the cause"
        : "当前证据无法确定具体原因",
    );
    await expect(dialog).not.toContainText(text.noIssues);
    await expect(dialog).not.toContainText(privateMessage);
    await expect(dialog.locator("summary, a")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: text.refresh, exact: true }),
    ).toHaveCount(0);
    const platform = await page.evaluate(() => {
      const ua = navigator.userAgent;
      return /Macintosh|Mac OS X/i.test(ua)
        ? "macos"
        : /Windows/i.test(ua)
          ? "windows"
          : /Linux/i.test(ua)
            ? "linux"
            : "web";
    });
    await expect(dialog.locator("ol > li")).toHaveCount(
      text.guidance[platform].length,
    );
    for (const [candidate, steps] of Object.entries(text.guidance))
      for (const step of steps)
        if (candidate === platform) await expect(dialog).toContainText(step);
        else await expect(dialog).not.toContainText(step);
    const details = dialog.getByRole("button", {
      name: text.details,
      exact: true,
    });
    await details.focus();
    await details.press("Enter");
    const code = page.getByRole("textbox", { name: text.details, exact: true });
    await expect(code).toHaveValue("ACCESS_DENIED");
    await expect(code).toHaveAttribute("readonly", "");
    await code.press("Escape");
    await expect(code).toHaveCount(0);
    await expect(details).toBeFocused();
    await expect(dialog).toBeVisible();
    expect(await deviceQueries(page)).toEqual(baseline);
    await recordLayoutAndAccessibility(page, dialog, info);
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();
    expect(
      await page.evaluate(() => window.workbenchFixture.connectCalls),
    ).toEqual(["device"]);
    await refreshFromDevicePicker(page, text.chooseDevice);
  });
}
