/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import type { WorkspaceDocument } from "@serial-workbench/contracts";
import { validateSerialConfiguration } from "../../packages/contracts/src/generated/validators.mjs";
import { seedWorkbenchFixture } from "./workbench.fixture";

// Only the Native boundary is controlled. Production providers and draft storage run unchanged.
const zh = {
  draft: "\u53d1\u9001\u8349\u7a3f",
  send: "\u53d1\u9001",
  saveDrafts: "\u4fdd\u5b58\u8349\u7a3f",
  clearDraft: "\u6e05\u7a7a\u53d1\u9001\u8349\u7a3f",
  retryHost: "\u91cd\u8bd5\u8fde\u63a5\u672c\u673a\u670d\u52a1",
  details: "\u67e5\u770b\u8be6\u60c5",
  logs: "\u65e5\u5fd7",
  logDetails: "\u65e5\u5fd7\u8be6\u60c5",
  menu: "\u5de5\u4f5c\u533a\u83dc\u5355",
  closeView: "\u5173\u95ed\u89c6\u56fe",
  newView: "\u65b0\u5efa\u89c6\u56fe",
  failed:
    "\u672c\u673a\u670d\u52a1\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002",
  connecting: "\u6b63\u5728\u8fde\u63a5\u672c\u673a\u670d\u52a1\u2026",
  restoring: "\u6b63\u5728\u6062\u590d\u672c\u5730\u8349\u7a3f\u2026",
  recoveryFailed:
    "\u672c\u5730\u8349\u7a3f\u672a\u6062\u590d\uff0c\u539f\u4ef6\u5df2\u4fdd\u7559\u3002\u8bf7\u91cd\u8bd5\u6216\u524d\u5f80\u8bbe\u7f6e\u4e2d\u7684\u8bca\u65ad\u4e0e\u6062\u590d\u3002",
  recover: "\u91cd\u8bd5\u6062\u590d\u8349\u7a3f",
};
const serialConfiguration = defaults.serialConfiguration;
if (!validateSerialConfiguration(serialConfiguration))
  throw new Error("Invalid generated serial fixture");

test("Host retry remains reachable after the transient failure notification expires", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { hostStart: "failed" });
  await page.goto("./#/");
  const notification = page.getByRole("alert").filter({ hasText: zh.failed });
  await expect(notification).toBeVisible();
  await expect(notification).toHaveCount(0);
  const retry = page
    .getByRole("main")
    .getByRole("button", { name: zh.retryHost, exact: true });
  await expect(retry).toBeEnabled();
  expect(
    await page.evaluate(() => window.workbenchFixture.attachmentCalls),
  ).toBe(1);
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  await retry.click();
  await expect(
    page.getByRole("button", { name: "Open Virtual serial", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => window.workbenchFixture.attachmentCalls),
  ).toBe(2);
  await expect(page.getByRole("tab")).toHaveCount(0);
});
const workspace: WorkspaceDocument = {
  ...defaults.workspace,
  name: "Restored bench",
  bindings: [
    {
      bindingId: "fixture-binding",
      hostId: "workbench-gui-host",
      deviceId: "device",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      configuration: serialConfiguration,
      reconnect: { enabled: false, maxDelayMs: "30000", maxAttempts: "10" },
    },
  ],
  views: ["saved-view", "unconnected"].map((id) => ({
    id,
    name: id === "saved-view" ? "Saved view" : "Saved unconnected ID",
    color: defaults.settings.customAccent,
    icon: "terminal",
    pinned: false,
    receiveMode: "text",
    sendMode: "text",
    bindingId: "fixture-binding",
  })),
};
const runtime = new WeakMap<
  Page,
  { errors: string[]; console: { type: string; text: string }[] }
>();
test.beforeEach(async ({ page }) => {
  const record = {
    errors: [] as string[],
    console: [] as { type: string; text: string }[],
  };
  runtime.set(page, record);
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
  const record = runtime.get(page);
  await writeFile(
    info.outputPath("runtime-and-ipc.json"),
    JSON.stringify({ ...record, fixture }, null, 2),
  );
  expect(record?.errors).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
});
async function evidence(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await writeFile(
    info.outputPath(`${name}-axe.json`),
    JSON.stringify(result, null, 2),
  );
  expect(result.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function safeText(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    "EXPLICIT_FIXTURE_SECRET",
  );
  await expect(page.locator("body")).not.toContainText("cargo run");
  await expect(page.locator("body")).not.toContainText(
    "C:/private/fixture-user",
  );
}

async function storedConnectionFailure(
  page: Page,
  labels: {
    menu: string;
    logs: string;
    details: string;
    logDetails: string;
    closeView: string;
    failed: string;
  },
) {
  // These cases use the narrow toolbar: persistent logs remain in its menu
  // after the transient failure notification has expired.
  await page
    .getByRole("main")
    .getByRole("button", { name: labels.menu, exact: true })
    .click();
  await page.getByRole("menuitem", { name: labels.logs, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: labels.logs, exact: true });
  const entry = dialog
    .getByRole("log", { name: labels.logs, exact: true })
    .getByRole("listitem")
    .filter({ hasText: labels.failed });
  await expect(entry).toHaveCount(1);
  const details = entry.getByRole("button", {
    name: labels.details,
    exact: true,
  });
  await details.focus();
  await details.press("Enter");
  const text = page.getByRole("textbox", {
    name: labels.logDetails,
    exact: true,
  });
  await expect(text).toHaveValue(
    /(?:^|\n)(?:错误代码|Error code): HOST_START_FAILED(?:\n|$)/,
  );
  await expect(text).not.toHaveValue(
    /EXPLICIT_FIXTURE_SECRET|cargo run|C:\/private\/fixture-user/,
  );
  await safeText(page);
  await text.press("Escape");
  await expect(text).toHaveCount(0);
  const close = dialog.getByRole("button", {
    name: labels.closeView,
    exact: true,
  });
  await close.focus();
  await close.press("Enter");
  await expect(dialog).toHaveCount(0);
}

test("first Host failure keeps recovered Chinese drafts editable and exposes safe keyboard retry", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, {
    hostStart: "failed",
    drafts: { unconnected: "ORIGINAL" },
  });
  await page.goto("./#/");
  const draft = page.getByRole("textbox", { name: zh.draft, exact: true });
  await expect(draft).toHaveValue("ORIGINAL");
  await expect(draft).toBeEditable();
  await expect(
    page.getByRole("alert").filter({ hasText: zh.failed }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: zh.send, exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: zh.newView, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^\u6253\u5f00/ })).toHaveCount(
    0,
  );
  const retry = page
    .getByRole("main")
    .getByRole("button", { name: zh.retryHost, exact: true });
  await expect(retry).toBeEnabled();
  await draft.fill("0123456789".repeat(24));
  await draft.focus();
  await draft.press("Shift+Tab");
  const clearDraft = page.getByRole("button", {
    name: zh.clearDraft,
    exact: true,
  });
  await expect(clearDraft).toBeFocused();
  await clearDraft.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: zh.saveDrafts, exact: true }),
  ).toBeFocused();
  const sender = page.getByRole("region", { name: zh.send, exact: true });
  const hex = sender.getByRole("radio", { name: "HEX", exact: true });
  await hex.focus();
  await hex.press("Space");
  await expect(draft).toHaveValue(
    Array(24).fill("30 31 32 33 34 35 36 37 38 39").join(" "),
  );
  await expect(page.locator(".workbench-draft-bytes")).toHaveText("240 B");
  await expect(
    page.locator(".workbench-preview-trigger,.workbench-byte-preview"),
  ).toHaveCount(0);
  await draft.focus();
  expect(
    await draft.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await draft.press("Control+End");
  await expect
    .poll(() => draft.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await writeFile(
    info.outputPath("converted-draft-keyboard.json"),
    JSON.stringify(
      await draft.evaluate((element) => ({
        focused: document.activeElement === element,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      })),
      null,
      2,
    ),
  );
  await page.screenshot({
    path: info.outputPath("first-failure-hex-draft-keyboard.png"),
  });
  const text = sender.getByRole("radio", { name: "文本", exact: true });
  await text.focus();
  await text.press("Space");
  await expect(draft).toHaveValue("0123456789".repeat(24));
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await draft.fill("EDITED OFFLINE");
  await page.getByRole("button", { name: zh.saveDrafts, exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts.unconnected === "EDITED OFFLINE",
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("alert").filter({ hasText: zh.failed }),
  ).toHaveCount(0);
  await storedConnectionFailure(page, zh);
  await safeText(page);
  await evidence(page, info, "first-failure-chinese-880");
  const attempts = await page.evaluate(
    () => window.workbenchFixture.attachmentCalls,
  );
  expect(attempts).toBe(1);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  await retry.focus();
  await retry.press("Enter");
  await expect(
    page.getByRole("button", { name: "Open Virtual serial", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Send draft", exact: true }),
  ).toHaveValue("EDITED OFFLINE");
  expect(
    await page.evaluate(() => window.workbenchFixture.attachmentCalls),
  ).toBe(attempts + 1);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("pending first connection retains the unbound draft across late workspace arrival and explicit device binding", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1120, height: 744 });
  await seedWorkbenchFixture(page, {
    hostStart: "pending",
    drafts: { unconnected: "ORIGINAL", "saved-view": "SAVED VIEW DRAFT" },
    workspace,
  });
  await page.goto("./#/");
  await expect(
    page.getByRole("status").filter({ hasText: zh.connecting }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: zh.connecting, exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /^\u6253\u5f00/ })).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: zh.draft, exact: true })
    .fill("EDITED BEFORE CONNECT");
  await evidence(page, info, "first-connecting-1120");
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toHaveValue("EDITED BEFORE CONNECT");
  const local = page.getByRole("tab", { name: "Send draft", exact: true });
  await expect(local).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(3);
  expect(
    await page
      .getByRole("tab")
      .evaluateAll((nodes) => new Set(nodes.map((n) => n.id)).size),
  ).toBe(3);
  const save = page.getByRole("button", {
    name: "Save current layout",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await expect(
    page.getByText(
      "The current draft has no device binding. Connect before saving the window layout. Drafts can be saved separately.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
  await page.getByRole("tab", { name: "Saved view", exact: true }).click();
  await expect(draft).toHaveValue("SAVED VIEW DRAFT");
  const sameNameView = page.getByRole("tab", {
    name: "Saved unconnected ID",
    exact: true,
  });
  await sameNameView.click();
  await expect(draft).toHaveValue("ORIGINAL");
  await draft.fill("REAL VIEW EDIT");
  await local.click();
  await expect(draft).toHaveValue("EDITED BEFORE CONNECT");
  await draft.fill("LOCAL EDIT AGAIN");
  await sameNameView.click();
  await expect(draft).toHaveValue("REAL VIEW EDIT");
  await local.click();
  await expect(draft).toHaveValue("LOCAL EDIT AGAIN");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) =>
            s.drafts.unconnected === "LOCAL EDIT AGAIN" &&
            s.drafts["saved-view"] === "SAVED VIEW DRAFT" &&
            s.drafts["view/unconnected"] === "REAL VIEW EDIT",
        ),
      ),
    )
    .toBe(true);
  await evidence(page, info, "late-workspace-unbound-draft");
  expect(
    await page.evaluate(() => window.workbenchFixture.attachmentCalls),
  ).toBe(1);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(local).toHaveCount(0);
  await expect(draft).toHaveValue("SAVED VIEW DRAFT");
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.workspaceWrites.length),
    )
    .toBe(1);
  const saved = await page.evaluate(
    () => window.workbenchFixture.workspaceWrites[0],
  );
  expect(saved?.views).toHaveLength(2);
  expect(saved?.views.map((v) => v.id)).toEqual(["saved-view", "unconnected"]);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual(["device"]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await evidence(page, info, "bound-layout-save-restored");
});

for (const access of ["pending", "failed"] as const)
  test(`local draft ${access} cannot expose or save an empty editor before explicit recovery`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, {
      hostStart: "failed",
      draftAccess: access,
      drafts: { unconnected: "ORIGINAL PRESERVED" },
    });
    await page.goto("./#/");
    await expect(
      page.getByText(access === "pending" ? zh.restoring : zh.recoveryFailed, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: zh.draft, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: zh.saveDrafts, exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => window.workbenchFixture.clientStateWrites),
    ).toEqual([]);
    await safeText(page);
    await evidence(page, info, `draft-${access}-safe-recovery`);
    await page.evaluate(() => window.workbenchFixture.releaseDrafts());
    if (access === "failed")
      await page.getByRole("button", { name: zh.recover, exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: zh.draft, exact: true }),
    ).toHaveValue("ORIGINAL PRESERVED");
    expect(
      await page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.every(
          (s) => s.drafts.unconnected === "ORIGINAL PRESERVED",
        ),
      ),
    ).toBe(true);
  });

test("an established Host losing its attachment preserves the current tab and draft while disabling Host actions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await seedWorkbenchFixture(page, { theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const tab = page.getByRole("tab", { name: "Virtual serial", exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const tabId = await tab.getAttribute("id");
  await page
    .getByRole("textbox", { name: "Send draft", exact: true })
    .fill("CURRENT EDIT");
  await page.evaluate(() => window.workbenchFixture.failRefresh());
  await page
    .getByRole("combobox", { name: "Choose device", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "The local service could not connect. Please retry.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "id",
    tabId!,
  );
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tablist", { name: "Sessions", exact: true }),
  ).not.toContainText("session-session");
  await expect(
    page.getByRole("textbox", { name: "Send draft", exact: true }),
  ).toHaveValue("CURRENT EDIT");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "New view", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Open(?: |$)/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", {
      name: "Retry local service connection",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "Choose device", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts["session-session"] === "CURRENT EDIT",
        ),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => window.workbenchFixture.attachmentCalls),
  ).toBe(1);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual(["device"]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await expect(
    page.getByRole("alert").filter({
      hasText: "The local service could not connect. Please retry.",
    }),
  ).toHaveCount(0);
  await storedConnectionFailure(page, {
    menu: "Workspace menu",
    logs: "Logs",
    details: "View details",
    logDetails: "Log details",
    closeView: "Close view",
    failed: "The local service could not connect. Please retry.",
  });
  await safeText(page);
  await evidence(page, info, "disconnected-current-tab-880");
});
