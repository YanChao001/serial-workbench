import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import { session } from "../../src/features/workbench/test-fixtures";
import { builtinAutomation } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const actionId = "swb.builtin.automation.script";
const scriptContribution: unknown = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === actionId,
);
if (!validateActionSpec(scriptContribution))
  throw new Error("Missing signed script action");
const spec = scriptContribution;

async function openScript(page: Page, state: "ready" | "held", narrow = false) {
  await page.setViewportSize(
    narrow ? { width: 420, height: 530 } : { width: 1240, height: 760 },
  );
  await seedWorkbenchFixture(page, {
    language: narrow ? "zh" : "en",
    theme: narrow ? "dark" : "light",
    device: {
      deviceId: "virtual:echo",
      hostId: "workbench-gui-host",
      systemName: "Virtual Echo",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities: session().capabilities,
    },
    automation: { action: spec, state, firstScriptCompletes: narrow },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: narrow ? "打开 Virtual Echo" : "Open Virtual Echo",
      exact: true,
    })
    .click();
  return openTool(page, narrow);
}

async function openTool(page: Page, narrow: boolean) {
  const title = narrow ? "运行脚本" : "Run script";
  await page
    .getByRole("button", { name: narrow ? "工作区菜单" : "Workspace menu" })
    .press("ArrowDown");
  await page.getByRole("menuitem", { name: title, exact: true }).click();
  return page.getByRole("dialog", { name: title, exact: true });
}

const submitted = (page: Page) =>
  page.evaluate(
    (action) => ({
      native: window.workbenchFixture.confirmedScripts,
      generic: window.workbenchFixture.invocations.filter(
        (call) => call.actionId === action,
      ),
    }),
    actionId,
  );

test("explicit native intent binds exact source and renders the verified result", async ({
  page,
}, info) => {
  const dialog = await openScript(page, "ready");
  const editor = dialog.getByRole("textbox", { name: "Source code" });
  const review = dialog.getByRole("button", { name: "Review and run…" });
  await expect(review).toBeEnabled();
  await review.click();
  await expect(editor).toBeFocused();
  const source =
    'export default async ({ log }) => { log("回环"); return "00 FF"; };\n';
  await dialog.getByRole("combobox", { name: "Language" }).selectOption("ts");
  await editor.fill(source);
  await expect(
    dialog.getByText(Buffer.byteLength(source) + " B"),
  ).toBeVisible();
  await review.click();
  const confirmation = page.getByRole("dialog", {
    name: "Confirm script execution",
  });
  const digest = createHash("sha256")
    .update("serial-workbench-script-v1\0ts\0" + source)
    .digest("hex");
  await expect(confirmation.getByText(digest)).toBeVisible();
  const back = confirmation.getByRole("button", { name: "Back to editing" });
  await expect(back).toBeFocused();
  expect(await submitted(page)).toEqual({ native: [], generic: [] });
  await back.press("Enter");
  await expect(confirmation).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await submitted(page)).toEqual({ native: [], generic: [] });

  await review.click();
  await confirmation
    .getByRole("button", { name: "Run script", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Completed");
  await expect(dialog.locator("pre")).toContainText('"bytes": "00 FF"');
  expect(await submitted(page)).toEqual({
    generic: [],
    native: [
      expect.objectContaining({
        language: "ts",
        source,
        sourceSha256: digest,
        sessionRevision: "1",
        configurationRevision: "1",
        target: expect.objectContaining({
          kind: "session",
          hostId: "workbench-gui-host",
        }),
      }),
    ],
  });
  await dialog.screenshot({ path: info.outputPath("trusted-script-wide.png") });
});

test("script editing highlights syntax, inserts SDK completions and snippets, and locates diagnostics", async ({
  page,
}, info) => {
  const dialog = await openScript(page, "ready");
  const editor = dialog.getByRole("textbox", { name: "Source code" });
  await editor.fill("export default async ({ serial }) => {\n  serial.s\n};");
  await expect(editor.locator(".script-code-keyword").first()).toHaveText(
    "export",
  );
  await editor.press("Control+End");
  await editor.press("ArrowUp");
  await editor.press("End");
  await editor.press("Control+Space");
  const completion = dialog.getByRole("option", { name: /^send\b/ });
  await expect(completion).toBeVisible();
  await editor.press("Escape");
  await expect(completion).toBeHidden();
  await expect(editor).toBeFocused();
  await editor.press("Control+Space");
  await expect(completion).toBeVisible();
  await completion.click();
  await expect(editor).toContainText("serial.send");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("serial.send");

  await editor.fill("export default async () => {\n  const broken = ;\n};");
  const error = dialog.getByRole("button", { name: /Line 2.*Check syntax/ });
  await expect(error).toBeVisible();
  await error.click();
  await expect(editor).toBeFocused();
  await expect(editor.locator(".cm-activeLine")).toContainText("const broken");
  await editor.fill("");
  await dialog.getByRole("button", { name: "Virtual Echo example" }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("0x00, 0xff");
  await expect(
    editor.locator(".script-code-call", { hasText: "log" }),
  ).toBeVisible();
  const codeLines = editor.locator(".cm-line");
  const original = await codeLines.allTextContents();
  await editor.press("Control+End");
  await editor.press("ArrowUp");
  await editor.press("ArrowUp");
  await editor.press("Home");
  await editor.press("Shift+End");
  await dialog.getByRole("button", { name: "Delay", exact: true }).click();
  await expect(codeLines.nth(3)).toHaveText("await delay(100);");
  await editor.press("Control+z");
  expect(await codeLines.allTextContents()).toEqual(original);
  const language = dialog.getByRole("combobox", { name: "Language" });
  await language.selectOption("ts");
  await language.selectOption("js");
  expect(await codeLines.allTextContents()).toEqual(original);
  expect(await submitted(page)).toEqual({ native: [], generic: [] });

  await dialog.screenshot({ path: info.outputPath("script-editor-wide.png") });
  await page.setViewportSize({ width: 420, height: 530 });
  const snippets = dialog.getByRole("button", { name: "Insert snippet" });
  await expect(snippets).toBeVisible();
  await editor.press("Control+Home");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.press("Enter");
  await snippets.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Log", exact: true }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('log("echo");');
  await editor.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Review and run…" }),
  ).toBeFocused();
  expect(await submitted(page)).toEqual({ native: [], generic: [] });
  await dialog.screenshot({
    path: info.outputPath("script-editor-narrow.png"),
  });
});

const debugSource = [
  "export default async function run() {",
  "  const count = 14;",
  "  const next = compute(count);",
  "  function compute(value) { return value + 2; }",
  "  return next;",
  "}",
].join("\n");

test("wide debugger confirms the exact breakpoints, steps, inspects a caller and continues", async ({
  page,
}, info) => {
  const dialog = await openScript(page, "ready");
  const editor = dialog.getByRole("textbox", { name: "Source code" });
  await editor.fill(debugSource);
  await editor.press("Control+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await dialog
    .getByRole("button", { name: "Toggle breakpoint at cursor" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Remove breakpoint on line 3" }),
  ).toBeVisible();
  await expect(dialog.locator(".script-breakpoint")).toHaveText("3");
  await dialog.getByRole("button", { name: "Review and debug…" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Confirm script debugging",
  });
  await expect(confirm.getByText("Breakpoints · 3")).toBeVisible();
  expect(await submitted(page)).toEqual({ native: [], generic: [] });
  await expect(
    confirm.getByRole("button", { name: "Back to editing" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Start debugging" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Paused on line 3");
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  await expect(editor.locator(".script-paused-line")).toContainText(
    "compute(count)",
  );
  expect((await submitted(page)).native).toEqual([
    expect.objectContaining({
      source: debugSource,
      sourceSha256: createHash("sha256")
        .update("serial-workbench-script-v1\0js\0" + debugSource)
        .digest("hex"),
      debugBreakpoints: [3],
    }),
  ]);

  await dialog.getByRole("button", { name: "Step into", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Paused on line 4");
  await expect(dialog.getByRole("region", { name: "Variables" })).toContainText(
    "16",
  );
  const caller = dialog.getByRole("button", { name: "run · 3:3", exact: true });
  await caller.click();
  await expect(caller).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("region", { name: "Variables" })).toContainText(
    "14",
  );
  await dialog.getByRole("button", { name: "Go to line 3, column 3" }).click();
  await expect(editor).toBeFocused();
  await expect(editor.locator(".script-paused-line")).toContainText(
    "function compute",
  );
  await dialog.screenshot({ path: info.outputPath("script-debug-wide.png") });
  await dialog.getByRole("button", { name: "Step out", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Paused on line 5");
  await page.evaluate(() => {
    window.workbenchFixture.holdNextDebugRead = true;
  });
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.debugReadHeld))
    .toBe(true);
  const resume = dialog.getByRole("button", { name: "Continue", exact: true });
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText(
    "Waiting for the debugger…",
  );
  await expect(resume).toBeFocused();
  await page.evaluate(() => window.workbenchFixture.releaseDebugRead());
  await expect(dialog.getByRole("status")).toHaveText("Running");
  await expect(
    dialog.getByRole("button", { name: "Stop", exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole("region", { name: "Variables" })).toBeHidden();
  expect(
    await page.evaluate(() => window.workbenchFixture.debugCommands),
  ).toEqual([
    { action: "stepInto", revision: "2" },
    { action: "inspectFrame", revision: "3", frame: 1 },
    { action: "stepOut", revision: "4" },
    { action: "continue", revision: "5" },
  ]);
});

test("narrow debugger reopens the owned pause and drops revoked and post-stop values", async ({
  page,
}, info) => {
  const dialog = await openScript(page, "ready", true);
  const editor = dialog.getByRole("textbox", { name: "源码" });
  await editor.fill(debugSource);
  const gutterLine = dialog
    .locator(".cm-lineNumbers .cm-gutterElement")
    .getByText("3", { exact: true });
  await gutterLine.click();
  await expect(
    dialog.getByRole("button", { name: "移除第 3 行断点" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "确认并调试…" }).click();
  await page
    .getByRole("dialog", { name: "确认调试脚本" })
    .getByRole("button", { name: "开始调试" })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("暂停于第 3 行");
  const variables = dialog.getByRole("region", { name: "变量" });
  await expect(variables).toContainText("14");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openTool(page, true);
  await expect(variables).toContainText("14");
  await expect(dialog.getByRole("button", { name: /定位至第/ })).toBeHidden();

  await page.evaluate(() => {
    window.workbenchFixture.debugDenied = true;
  });
  await expect(variables).toBeHidden();
  await expect(dialog.getByRole("status")).toHaveText(
    "此脚本调试会话已不可用。",
  );
  await expect(dialog.getByRole("group", { name: "调试控制" })).toBeHidden();
  await page.evaluate(() => {
    window.workbenchFixture.debugDenied = false;
  });
  await expect(variables).toContainText("14");

  await page.evaluate(() => {
    window.workbenchFixture.holdNextDebugRead = true;
  });
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.debugReadHeld))
    .toBe(true);
  await page.evaluate(() => {
    window.workbenchFixture.debugDenied = true;
  });
  await dialog.getByRole("button", { name: "继续", exact: true }).click();
  await expect(variables).toBeHidden();
  await page.evaluate(() => {
    const fixture = window.workbenchFixture;
    fixture.debugDenied = false;
    fixture.holdNextDebugRead = true;
    fixture.releaseDebugRead();
  });
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.holdNextDebugRead))
    .toBe(false);
  await expect(variables).toBeHidden();
  await page.evaluate(() => window.workbenchFixture.releaseDebugRead());
  await expect(variables).toContainText("14");

  const stop = dialog.getByRole("button", { name: "停止", exact: true });
  await variables.scrollIntoViewIfNeeded();
  await expect(variables).toBeInViewport();
  await expect(stop).toBeInViewport();
  await dialog.screenshot({ path: info.outputPath("script-debug-narrow.png") });
  await page.evaluate(() => {
    window.workbenchFixture.holdNextDebugRead = true;
  });
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.debugReadHeld))
    .toBe(true);
  await stop.click();
  await expect(dialog.getByRole("status")).toHaveText("正在请求停止");
  await page.evaluate(() => {
    window.workbenchFixture.finishAutomationCancellation();
    window.workbenchFixture.releaseDebugRead();
  });
  await expect(dialog.getByRole("status")).toHaveText("已停止");
  await expect(variables).toBeHidden();
  expect((await submitted(page)).native).toHaveLength(1);
});

test("narrow Chinese tool reopens the active script and distinguishes requested stop from terminal", async ({
  page,
}, info) => {
  const dialog = await openScript(page, "held", true);
  const editor = dialog.getByRole("textbox", { name: "源码" });
  await editor.fill("export default ({ serial }) => serial.s");
  await editor.press("Control+End");
  await editor.press("Control+Space");
  const suggestions = dialog.getByRole("listbox", { name: "补全" });
  await expect(suggestions).toBeVisible();
  await editor.press("Escape");
  await expect(suggestions).toBeHidden();
  await editor.dispatchEvent("compositionstart");
  await editor.dispatchEvent("keydown", {
    key: "Escape",
    code: "Escape",
    isComposing: true,
  });
  await editor.dispatchEvent("compositionend");
  await expect(editor).toBeFocused();
  await editor.fill("export default async () => { return 0; };");
  await dialog.getByRole("button", { name: "确认并运行…" }).click();
  const confirmation = page.getByRole("dialog", { name: "确认运行脚本" });
  await expect(
    confirmation.getByRole("button", { name: "返回编辑" }),
  ).toBeFocused();
  await confirmation.getByRole("button", { name: "运行脚本" }).click();
  await expect(dialog.getByRole("status")).toHaveText("已完成");
  await dialog.getByRole("button", { name: "确认并运行…" }).click();
  await confirmation.getByRole("button", { name: "运行脚本" }).click();
  await expect(dialog.getByRole("status")).toHaveText("执行中");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openTool(page, true);
  await expect(dialog.getByRole("status")).toHaveText("执行中");
  await expect(
    dialog.getByRole("button", { name: "确认并运行…" }),
  ).toBeDisabled();
  const stop = dialog.getByRole("button", { name: "停止", exact: true });
  await expect(stop).toBeInViewport();
  await dialog.screenshot({
    path: info.outputPath("trusted-script-narrow.png"),
  });
  await stop.click();
  await expect(dialog.getByRole("status")).toHaveText("正在请求停止");
  await expect(stop).toBeDisabled();
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByRole("status")).toHaveText("已停止");
  expect((await submitted(page)).native).toHaveLength(2);
});
