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
