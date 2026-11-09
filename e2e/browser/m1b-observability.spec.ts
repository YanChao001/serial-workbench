/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { FileMetadata } from "@serial-workbench/contracts";
import {
  seedWorkbenchFixture,
  type ObservationFixture,
} from "./workbench.fixture";

// Controlled UI replies, deliberately distinct from real Host or hardware evidence.
const observations: ObservationFixture = {
  inputs: {
    sessionId: "session",
    sessionEpoch: "1",
    sampledAt: "2026-11-08T12:00:01Z",
    sampledMonoNs: "123456789",
    cts: true,
    dsr: false,
    ri: true,
    cd: false,
  },
  metrics: {
    sessionId: "session",
    sessionEpoch: "1",
    instanceEpoch: "1",
    observedAt: "2026-11-08T12:00:02Z",
    observedMonoNs: "223456789",
    connectionDurationMs: "90001",
    rxBytes: "9007199254741999",
    txAcceptedBytes: "9007199254742000",
    txUnknownBytes: "111",
    rxReadErrors: "7",
    txWriteErrors: "8",
    rxBytesPerSecond: "222",
    txAcceptedBytesPerSecond: "333",
    rateWindowMs: "1000",
    rateResolutionMs: "10",
    lineErrorsAvailable: false,
    frameCountsAvailable: false,
  },
  hostMetrics: {
    hostId: "workbench-gui-host",
    instanceEpoch: "1",
    processId: "42",
    observedAt: "2026-11-08T12:00:02Z",
    rssBytes: "104857600",
    rssPeakBytes: "125829120",
    source: { usedBytes: "13", peakBytes: "20", limitBytes: "40" },
    reader: { usedBytes: "3", peakBytes: "5", limitBytes: "10" },
    captureQueue: { usedBytes: "7", peakBytes: "8", limitBytes: "16" },
  },
};
const captureTarget = {
  reference: {
    hostId: "workbench-gui-host",
    kind: "file",
    id: "capture-target",
    revision: "3",
  },
  name: "explicit-ui-fixture.swb",
  mime: "application/octet-stream",
  length: "4096",
};
const metadata: FileMetadata = {
  fileRef: captureTarget.reference,
  purpose: "capture_target",
  length: "4096",
  fingerprint: "c".repeat(64),
};
const failures = new WeakMap<Page, string[]>();
const consoleRecords = new WeakMap<Page, { type: string; text: string }[]>();
test.beforeEach(async ({ page }) => {
  consoleRecords.set(page, []);
  const errors: string[] = [];
  failures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    consoleRecords
      .get(page)
      ?.push({ type: message.type(), text: message.text() });
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
});
test.afterEach(async ({ page }, info) => {
  const errors = failures.get(page) ?? [];
  const fixture = await page.evaluate(() => window.workbenchFixture);
  const record = info.outputPath("explicit-runtime-and-ipc.json");
  await writeFile(
    record,
    JSON.stringify(
      { errors, console: consoleRecords.get(page) ?? [], fixture },
      null,
      2,
    ),
  );
  await info.attach("explicit-ui-runtime-and-ipc", {
    path: record,
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
});
async function openSession(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
}
async function openTool(page: Page, name: string) {
  const trigger = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("Enter");
  const item = page.getByRole("menuitem", { name, exact: true });
  await item.focus();
  await item.press("Enter");
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function scan(page: Page, selector: string, info: TestInfo) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const record = info.outputPath("accessibility.json");
  await writeFile(record, JSON.stringify(result, null, 2));
  await info.attach("accessibility", {
    path: record,
    contentType: "application/json",
  });
  expect(result.violations).toEqual([]);
}

test("terminal typography exposes four searchable controls and keyboard edits reach the sender without changing global typography", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, { currentPage: "settings", theme: "light" });
  await page.goto("./#/settings");
  const search = page.getByRole("searchbox", {
    name: "Search settings",
    exact: true,
  });
  await search.fill("terminal ligatures");
  await expect(
    page.getByRole("dialog", { name: "Search settings", exact: true }),
  ).toContainText("Terminal typography");
  await search.press("Enter");
  const group = page.locator("#settings-terminalTypography");
  await expect(group).toBeFocused();
  const family = group.getByRole("textbox", {
    name: "Terminal font family",
    exact: true,
  });
  const size = group.getByRole("spinbutton", {
    name: "Terminal font size (px)",
    exact: true,
  });
  const line = group.getByRole("spinbutton", {
    name: "Terminal line height (%)",
    exact: true,
  });
  const ligatures = group.getByRole("switch", {
    name: "Terminal ligatures",
    exact: true,
  });
  await expect(family).toHaveValue("ui-monospace");
  await expect(size).toHaveValue("14");
  await expect(line).toHaveValue("150");
  await expect(ligatures).not.toBeChecked();
  await family.fill("monospace");
  await family.press("Enter");
  await size.fill("20");
  await size.press("Enter");
  await line.fill("175");
  await line.press("Enter");
  await ligatures.focus();
  await ligatures.press("Space");
  await expect(ligatures).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.settingsWrites.at(-1)?.terminal.typography,
      ),
    )
    .toEqual({
      fontFamily: "monospace",
      fontSize: 20,
      lineHeightPercent: 175,
      ligatures: true,
    });
  await size.fill("7");
  await size.press("Enter");
  await expect(size).toHaveAttribute("aria-invalid", "true");
  await expect(
    group.getByRole("button", {
      name: "Apply terminal typography",
      exact: true,
    }),
  ).toBeDisabled();
  await group
    .getByRole("button", { name: "Revert terminal typography", exact: true })
    .click();
  await expect(size).toHaveValue("20");
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("terminal-typography-880-light.png"),
  });
  await scan(page, "#settings-terminalTypography", info);
  await page
    .locator("#app-sidebar-navigation")
    .getByRole("link", { name: "Serial Workbench", exact: true })
    .click();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toHaveCSS("font-family", "monospace");
  await expect(draft).toHaveCSS("font-size", "20px");
  await expect(draft).toHaveCSS("line-height", "35px");
  await expect(draft).toHaveCSS("font-variant-ligatures", "normal");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "md");
});

test("Chinese terminal typography keeps the four fixed control labels in a large dark image window", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await seedWorkbenchFixture(page, {
    currentPage: "settings",
    theme: "dark",
    language: "zh",
  });
  await page.goto("./#/settings");
  const group = page.locator("#settings-terminalTypography");
  await expect(
    group.getByRole("textbox", {
      name: "\u7ec8\u7aef\u5b57\u4f53",
      exact: true,
    }),
  ).toBeEditable();
  await expect(
    group.getByRole("spinbutton", {
      name: "\u7ec8\u7aef\u5b57\u53f7\uff08px\uff09",
      exact: true,
    }),
  ).toBeEditable();
  await expect(
    group.getByRole("spinbutton", {
      name: "\u7ec8\u7aef\u884c\u9ad8\uff08%\uff09",
      exact: true,
    }),
  ).toBeEditable();
  await expect(
    group.getByRole("switch", {
      name: "\u7ec8\u7aef\u8fde\u5b57",
      exact: true,
    }),
  ).toBeEnabled();
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("terminal-typography-1280-zh-dark.png"),
  });
  await scan(page, "#settings-terminalTypography", info);
});

for (const readOnly of [false, true])
  test(`explicit input samples are reads while output controls follow readOnly=${readOnly}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, { theme: "dark", observations, readOnly });
    await openSession(page);
    const trigger = page.getByRole("button", {
      name: /^Connection parameters/,
    });
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Connection parameters",
      exact: true,
    });
    const inputs = dialog.getByRole("region", {
      name: "Actual input samples",
      exact: true,
    });
    await expect(inputs.getByLabel("CTS", { exact: true })).toHaveText("On");
    await expect(inputs.getByLabel("DSR", { exact: true })).toHaveText("Off");
    await expect(inputs.getByLabel("RI", { exact: true })).toHaveText("On");
    await expect(inputs.getByLabel("CD", { exact: true })).toHaveText("Off");
    await expect(inputs).toContainText("2026-11-08T12:00:01Z");
    await expect(inputs).toContainText("123456789 ns");
    if (readOnly)
      await expect(
        dialog.getByRole("button", { name: "DTR on", exact: true }),
      ).toBeDisabled();
    else
      await expect(
        dialog.getByRole("button", { name: "DTR on", exact: true }),
      ).toBeEnabled();
    await expect(
      inputs.getByRole("button", { name: "Refresh inputs", exact: true }),
    ).toBeEnabled();
    const requests = await page.evaluate(() =>
      window.workbenchFixture.queryInputs.filter(
        (q) => q.actionId === "session.inputs",
      ),
    );
    expect(requests[0]?.target).toMatchObject({
      hostId: "workbench-gui-host",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    });
    expect(
      await page.evaluate(() =>
        window.workbenchFixture.invocations.filter(
          (c) => c.actionId === "session.control",
        ),
      ),
    ).toEqual([]);
    await inputs.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`inputs-readonly-${readOnly}.png`),
    });
    await scan(page, '[role="dialog"]', info);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

test("unsupported input sampling displays unknown rather than inferred control-line state", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1120, height: 744 });
  await seedWorkbenchFixture(page, {
    observations: { ...observations, inputs: "unsupported" },
  });
  await openSession(page);
  await page.getByRole("button", { name: /^Connection parameters/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Connection parameters",
    exact: true,
  });
  const inputs = dialog.getByRole("region", {
    name: "Actual input samples",
    exact: true,
  });
  await expect(inputs).toContainText(
    "CTS / DSR / RI / CD sampling is unavailable",
  );
  for (const name of ["CTS", "DSR", "RI", "CD"])
    await expect(inputs.getByLabel(name, { exact: true })).toHaveText(
      "Unknown",
    );
  await expect(
    inputs.getByRole("button", { name: "Refresh inputs", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "DTR on", exact: true }),
  ).toBeEnabled();
  await inputs.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("inputs-unsupported.png") });
});

for (const theme of ["light", "dark"] as const)
  test(`session metrics display explicit exact counters and unavailable estimates in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(
      theme === "light"
        ? { width: 1280, height: 820 }
        : { width: 880, height: 600 },
    );
    await seedWorkbenchFixture(page, { theme, observations });
    await openSession(page);
    const dialog = await openTool(page, "Host metrics");
    const metrics = dialog.getByRole("region", {
      name: "Session metrics",
      exact: true,
    });
    await expect(metrics).toContainText("9007199254741999");
    await expect(metrics).toContainText("9007199254742000");
    await expect(metrics).toContainText("90001");
    await expect(
      metrics
        .getByText("RX bytes across reconnects", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("9007199254741999");
    await expect(
      metrics
        .getByText("TX bytes accepted by Host across reconnects", {
          exact: true,
        })
        .locator("..")
        .locator("dd"),
    ).toHaveText("9007199254742000");
    await expect(
      metrics
        .getByText("RX I/O errors across reconnects", { exact: true })
        .locator("..")
        .locator("dd"),
    ).toHaveText("7");
    await expect(metrics.getByText("Unavailable", { exact: true })).toHaveCount(
      2,
    );
    await expect(
      metrics.getByText("Line framing / parity errors", { exact: true }),
    ).toBeVisible();
    await expect(
      metrics.getByText("Frame counts", { exact: true }),
    ).toBeVisible();
    await metrics.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`session-metrics-${theme}.png`),
    });
    await scan(page, '[role="dialog"]', info);
  });

test("capture limits send exact MiB bytes and replacement fingerprint remains read-only", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, {
    theme: "light",
    captureTarget,
    fileMetadata: metadata,
  });
  await page.goto("./#/");
  const unboundDialog = await openTool(page, "Capture and replay tools");
  await unboundDialog
    .getByRole("button", { name: "Select capture destination", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.filePickerCalls))
    .toEqual([
      { role: "captureTarget", generation: "1", captureNameHint: null },
    ]);
  await writeFile(
    info.outputPath("capture-picker-without-session.json"),
    JSON.stringify(
      await page.evaluate(() => window.workbenchFixture.filePickerCalls),
      null,
      2,
    ),
  );
  await unboundDialog.press("Escape");
  await expect(unboundDialog).toHaveCount(0);
  await openSession(page);
  const dialog = await openTool(page, "Capture and replay tools");
  const start = dialog.getByRole("group", {
    name: "Start capture",
    exact: true,
  });
  await expect(start.getByLabel("Capacity (MiB)", { exact: true })).toHaveValue(
    "1024",
  );
  await expect(
    start.getByLabel("Disk reserve (MiB)", { exact: true }),
  ).toHaveValue("128");
  await start
    .getByRole("button", { name: "Select capture destination", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.filePickerCalls))
    .toEqual([
      { role: "captureTarget", generation: "1", captureNameHint: null },
      {
        role: "captureTarget",
        generation: "1",
        captureNameHint: { deviceName: "Virtual serial", baudRate: "115200" },
      },
    ]);
  await expect(
    page.getByText("explicit-ui-fixture.swb", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Capture and replay tools");
  await start
    .getByRole("combobox", { name: "Write mode", exact: true })
    .selectOption("replace");
  const fingerprint = start.getByRole("textbox", {
    name: "Expected SHA-256 fingerprint",
    exact: true,
  });
  await expect(fingerprint).toHaveValue("c".repeat(64));
  await expect(fingerprint).not.toBeEditable();
  await expect(start.getByLabel("Target revision", { exact: true })).toHaveText(
    "3",
  );
  await start.getByLabel("Capacity (MiB)", { exact: true }).fill("2.5");
  await expect(
    start.getByRole("button", { name: "Start capture", exact: true }),
  ).toBeDisabled();
  await start.getByLabel("Capacity (MiB)", { exact: true }).fill("2");
  await start.getByLabel("Disk reserve (MiB)", { exact: true }).fill("1");
  await expect(
    start.getByRole("button", { name: "Start capture", exact: true }),
  ).toBeDisabled();
  await start
    .getByRole("checkbox", { name: "Confirm replacement", exact: true })
    .check();
  await expect(
    start.getByRole("button", { name: "Start capture", exact: true }),
  ).toBeEnabled();
  await start.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("capture-mib-fingerprint.png"),
  });
  await scan(page, '[role="dialog"]', info);
  await start
    .getByRole("button", { name: "Start capture", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.filter(
          (c) => c.actionId === "capture.start",
        ),
      ),
    )
    .toHaveLength(1);
  const call = await page.evaluate(() =>
    window.workbenchFixture.invocations.find(
      (c) => c.actionId === "capture.start",
    ),
  );
  expect(call?.params).toMatchObject({
    storageLimits: { capacityBytes: "2097152", reserveBytes: "1048576" },
    expectedFingerprint: "c".repeat(64),
    targetRef: captureTarget.reference,
  });
});
