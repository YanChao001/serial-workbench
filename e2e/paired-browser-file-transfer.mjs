import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const [output] = process.argv.slice(2);
assert.ok(output, "Missing browser transfer evidence directory");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const line = await input[Symbol.asyncIterator]().next();
assert.ok(!line.done, "Missing Host pairing fixture");
const fixture = JSON.parse(line.value);
input.close();
assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const calls = [];
let stage = "load and pair";
let page;
try {
  page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 420, height: 610 },
    reducedMotion: "reduce",
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { body, requestId } = JSON.parse(payload);
      if (body.request?.method !== "browser.fileHandoff") return;
      const params = body.request.params;
      calls.push({
        kind: params.kind,
        ...(params.kind === "submit"
          ? {
              frameMatchesCall: requestId === params.call.requestId,
              offset: params.call.params.offset,
              length: params.call.params.length,
              targetId: params.call.target.id,
            }
          : {}),
      });
    });
  });
  assert.ok((await page.goto(fixture.url))?.ok());
  const pairing = page.getByLabel(/^(Pairing code|配对码)$/);
  await pairing.fill(fixture.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(pairing).toHaveCount(0, { timeout: 30_000 });

  stage = "attach the existing Virtual Echo session";
  const device = page.getByRole("combobox", {
    name: /^(Choose device|选择设备)$/,
  });
  await expect(device).toBeEnabled({ timeout: 15000 });
  await device.click();
  await page.getByRole("option", { name: "virtual:echo", exact: true }).click();
  const tab = page.getByRole("tab", { name: "virtual:echo", exact: true });
  const open = page.getByRole("button", { name: /^(Open|打开) virtual:echo$/ });
  await open.or(tab).first().waitFor();
  if (await open.isVisible()) await open.click();
  await expect(tab).toBeVisible({ timeout: 15000 });

  stage = "open file transfer";
  const workspace = page.getByRole("button", {
    name: /^(Workspace menu|工作区菜单)$/,
    exact: true,
  });
  await workspace.press("ArrowDown", { timeout: 30_000 });
  const transfer = page.getByRole("menuitem", {
    name: /^(File transfer|文件传输)$/,
    exact: true,
  });
  await expect(transfer).toBeEnabled({ timeout: 15_000 });
  await transfer.click();
  const dialog = page.getByRole("dialog", {
    name: /^(File transfer|文件传输)$/,
    exact: true,
  });
  const choose = dialog.getByRole("button", {
    name: /^(Select source file|选择源文件)$/,
  });
  await expect(choose).toBeEnabled({ timeout: 15_000 });

  stage = "file selection and scoped drop";
  const initial = "selected-by-file-dialog.bin";
  const fileChooser = page.waitForEvent("filechooser");
  await choose.click();
  await (
    await fileChooser
  ).setFiles({
    name: initial,
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 1]),
  });
  await expect(
    dialog.getByRole("textbox", { name: /^(Source file|源文件)$/ }),
  ).toHaveValue(initial);
  const longName = "paired-browser-transfer-" + "0123456789".repeat(8) + ".bin";
  const dataTransfer = await page.evaluateHandle((name) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.of(0, 254, 35, 122)], name));
    return data;
  }, longName);
  await dialog
    .getByRole("tab", { name: /^(Advanced|高级)$/ })
    .dispatchEvent("drop", { dataTransfer });
  const source = dialog.getByRole("textbox", {
    name: /^(Source file|源文件)$/,
  });
  await expect(source).toHaveValue(initial);
  await source.dispatchEvent("drop", { dataTransfer });
  await expect(source).toHaveValue(longName);
  await dialog.getByLabel(/^(Byte offset|字节偏移)$/).fill("1");
  await dialog.getByLabel(/^(Length \(bytes\)|长度（字节）)$/).fill("2");
  await expect(
    dialog.getByLabel(/^(Beginning of selected bytes|选区开头字节)$/),
  ).toHaveText("1: FE 23");
  const bar = dialog.getByRole("progressbar", {
    name: /^(Transfer progress|传输进度)$/,
  });
  await expect(bar).toHaveCount(0);
  const send = dialog.getByRole("button", {
    name: /^(Send file|发送文件)$/,
    exact: true,
  });
  await expect(send).toBeEnabled();
  await expect(
    dialog.getByLabel(/^(Beginning of selected bytes|选区开头字节)$/),
  ).toBeInViewport({ ratio: 1 });
  assert.deepEqual(calls, []);
  await dialog.screenshot({
    path: join(output, "narrow-browser-transfer.png"),
  });
  await page.setViewportSize({ width: 1240, height: 820 });
  await expect(send).toBeVisible();
  await dialog.screenshot({ path: join(output, "wide-browser-transfer.png") });

  stage = "confirmed transfer";
  await send.click();
  await expect
    .poll(() => calls.map(({ kind }) => kind))
    .toEqual(["begin", "append", "seal", "submit"]);
  await expect(bar).toHaveAttribute("aria-valuetext", "2 B / 2 B", {
    timeout: 15_000,
  });
  assert.deepEqual(calls, [
    { kind: "begin" },
    { kind: "append" },
    { kind: "seal" },
    {
      kind: "submit",
      frameMatchesCall: true,
      offset: "1",
      length: "2",
      targetId: fixture.targetId,
    },
  ]);

  stage = "open the shared command library";
  await dialog.getByRole("button", { name: /^(Close view|关闭视图)$/ }).click();
  const discardTransferDraft = page.getByRole("button", {
    name: /^(Discard and continue|放弃并继续)$/,
  });
  await discardTransferDraft.click();
  await page.setViewportSize({ width: 420, height: 660 });
  const libraryEntry = page.getByRole("button", {
    name: /^(Command library|命令库)$/,
  });
  await expect(libraryEntry).toBeEnabled({ timeout: 15000 });
  await libraryEntry.click();
  const library = page.getByRole("dialog", {
    name: /^(Command library|命令库)$/,
  });
  const save = library.getByRole("button", { name: /^(Save|保存)$/ });
  const name = library.getByRole("textbox", { name: /^(Name|名称)$/ });
  await library.getByRole("button", { name: /^(New group|新建分组)$/ }).click();
  await name.fill("Browser slot regression");
  await save.click();
  const group = library.getByRole("button", {
    name: "Browser slot regression",
    exact: true,
  });
  await expect(group).toBeVisible();
  await group.click();
  await library
    .getByRole("button", { name: /^(New command|新建命令)$/ })
    .click();
  await name.fill("File-backed command");
  const body = library.getByRole("textbox", {
    name: /^(Command body|命令正文)$/,
  });
  const note = library.getByRole("textbox", { name: /^(Note|备注)$/ });
  await body.fill("original");
  await note.fill("Preserve this note");

  stage = "command slot local preview and cancellation";
  const importButton = library.getByRole("button", {
    name: /^(Load file…|载入文件…)$/,
  });
  const pick = page.waitForEvent("filechooser");
  await importButton.press("Enter");
  await (
    await pick
  ).setFiles({
    name: "command-pick.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 255, 36, 123]),
  });
  const pickedBody = library.getByRole("group", {
    name: "command-pick.bin",
    exact: true,
  });
  await expect(pickedBody).toContainText("00 FF 24 7B");
  await expect(body).toHaveValue("original");
  await pickedBody
    .getByRole("button", { name: /^(Cancel import|取消导入)$/ })
    .click();
  await expect(importButton).toBeFocused();
  await expect(body).toHaveValue("original");

  for (const [size, message] of [
    [0, /at least one byte|至少包含一个字节|至少包含 1 个字节/],
    [21846, /21,845/],
  ]) {
    const picker = page.waitForEvent("filechooser");
    await importButton.press("Enter");
    await (
      await picker
    ).setFiles({
      name: "command-boundary.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(size, 65),
    });
    await expect(library.getByRole("alert")).toContainText(message);
    await expect(body).toHaveValue("original");
  }
  const limitPicker = page.waitForEvent("filechooser");
  await importButton.press("Enter");
  await (
    await limitPicker
  ).setFiles({
    name: "command-maximum.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(21845, 65),
  });
  const maximum = library.getByRole("group", {
    name: "command-maximum.bin",
    exact: true,
  });
  await expect(maximum).toContainText("21,845");
  await maximum
    .getByRole("button", { name: /^(Cancel import|取消导入)$/ })
    .click();
  await expect(body).toHaveValue("original");

  stage = "command slot scoped file drops";
  const multiple = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["A"], "first.bin"));
    data.items.add(new File(["B"], "second.bin"));
    return data;
  });
  await body.dispatchEvent("drop", { dataTransfer: multiple });
  await expect(library.getByRole("alert")).toHaveText(
    /one command body file|一个命令正文文件/,
  );
  await expect(body).toHaveValue("original");
  const slotName = "command-source-" + "0123456789".repeat(6) + ".bin";
  const slot = await page.evaluateHandle((name) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.of(9, 255, 0, 65)], name));
    return data;
  }, slotName);
  await note.dispatchEvent("drop", { dataTransfer: slot });
  await expect(
    library.getByRole("group", { name: slotName, exact: true }),
  ).toHaveCount(0);
  await body.dispatchEvent("drop", { dataTransfer: slot });
  const slotPreview = library.getByRole("group", {
    name: slotName,
    exact: true,
  });
  await expect(slotPreview).toContainText("09 FF 00 41");
  await slotPreview.screenshot({
    path: join(output, "narrow-browser-command-file.png"),
  });
  await page.setViewportSize({ width: 1240, height: 820 });
  await expect(slotPreview).toBeVisible();
  await slotPreview.screenshot({
    path: join(output, "wide-browser-command-file.png"),
  });
  await slotPreview
    .getByRole("button", { name: /^(Replace command body|替换命令正文)$/ })
    .click();
  await expect(body).toHaveValue("09 FF 00 41");
  await expect(body).toBeFocused();
  await expect(note).toHaveValue("Preserve this note");
  await save.click();
  const saved = library.getByRole("button", {
    name: "File-backed command",
    exact: true,
  });
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(body).toHaveValue("09 FF 00 41");
  await expect(note).toHaveValue("Preserve this note");
  assert.equal(
    calls.length,
    4,
    "Loading a command draft must not upload a transfer",
  );
  await writeFile(
    join(output, "browser-transfer-receipt.json"),
    JSON.stringify(
      {
        calls,
        acceptedBytes: 2,
        commandBody: "09 FF 00 41",
        commandReopened: true,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  const message = String(error).replaceAll(fixture.pairingCode, "[redacted]");
  console.error(
    "Paired browser file transfer failed during " + stage + ": " + message,
  );
  process.exitCode = 1;
  if (page && stage !== "load and pair") {
    const state = await page
      .locator("body")
      .ariaSnapshot({ timeout: 3000 })
      .catch(() => "");
    await writeFile(
      join(output, "browser-transfer-failure.txt"),
      state.replaceAll(fixture.pairingCode, "[redacted]"),
    );
  }
} finally {
  await browser.close();
}
