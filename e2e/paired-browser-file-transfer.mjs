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
  await writeFile(
    join(output, "browser-transfer-receipt.json"),
    JSON.stringify({ calls, acceptedBytes: 2 }, null, 2) + "\n",
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
