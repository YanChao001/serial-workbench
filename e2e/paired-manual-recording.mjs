import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function checkManualRecording({ page, readRaw, source, output }) {
  const before = await readRaw("manual-recording-before");
  const receive = page.getByRole("region", { name: /^(Receive|接收)$/ });
  const send = page.getByRole("region", { name: /^(Send|发送)$/ });
  const recorder = send.getByRole("button", {
    name: /^(Record manual sends|录制手工发送)$/,
  });
  const recorded = page.getByRole("dialog", {
    name: /^(Record manual sends|录制手工发送)$/,
  });
  await recorder.click();
  await recorded
    .getByRole("checkbox", {
      name: /^(Store sent bytes as input references|将发送字节保存为输入引用)$/,
    })
    .check();
  await recorded
    .getByRole("button", { name: /^(Start recording|开始录制)$/ })
    .click();
  const manual = "RECORD-ONE";
  const recordedSelection = Buffer.from("<&");
  const replacementFile = Buffer.from([0, 255, 63, 43]);
  const draft = send.getByRole("textbox", { name: /Send draft|发送草稿/ });
  await draft.fill(manual);
  await send.getByRole("button", { name: /^(Send|发送)$/ }).click();
  await recorder.click();
  await expect(recorded.getByRole("status")).toContainText(
    /Confirmed sends: 1\.|已确认 1 次发送。/,
  );
  await page.keyboard.press("Escape");

  await receive.getByRole("radio", { name: "HEX", exact: true }).click();
  const log = receive.getByRole("log");
  const previewTitle = /^(Preview send selection|预览发送选区)$/;
  const preview = page.getByRole("dialog", { name: previewTitle });
  const sample = log.locator(
    '[data-direction="rx"] [data-hex-byte-start="' +
      source.payload.byteStart +
      '"]',
  );
  const sampleBytes = Buffer.from(source.payload.bytesBase64, "base64");
  const selectFrom = (sampleBytes.length - 2) * 3;
  const selectTo = selectFrom + 5;
  async function openPreview() {
    await sample.scrollIntoViewIfNeeded();
    await sample.evaluate(
      (element, { from, to }) => {
        const text = element.firstChild;
        if (!text) throw new Error("Missing real RX payload");
        document.getSelection()?.setBaseAndExtent(text, from, text, to);
      },
      { from: selectFrom, to: selectTo },
    );
    await log.press("Shift+F10");
    await page.getByRole("menuitem", { name: previewTitle }).click();
    await expect(preview.locator("pre")).toHaveText("3C 26");
  }

  const sentBytes = (page) =>
    page.events
      .filter(({ kind }) => kind === "tx")
      .map(({ payload }) => {
        assert.equal(payload.outcome, "accepted");
        return Buffer.from(payload.bytesBase64, "base64");
      });
  await openPreview();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(log).toBeFocused();
  assert.deepEqual(
    sentBytes(await readRaw("manual-recording-cancel", before.nextEventSeq)),
    [Buffer.from(manual)],
  );
  await openPreview();
  await preview
    .getByRole("button", { name: /^(Confirm send|确认发送)$/ })
    .click();
  await expect(
    preview.getByRole("status").filter({ hasText: /[0-9a-f-]{36}/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(draft).toHaveValue(manual);

  await recorder.click();
  await recorded
    .getByRole("button", { name: /^(Stop recording|停止录制)$/ })
    .click();
  await expect(recorded.getByRole("status")).toContainText(
    /Confirmed sends: 2\.|已确认 2 次发送。/,
  );
  await recorded
    .getByRole("button", {
      name: /^(Review in command sequence|在命令序列中查看)$/,
    })
    .click();
  const sequence = page.getByRole("dialog", {
    name: /^(Command sequence|命令序列)$/,
  });
  const editor = sequence.getByRole("textbox", {
    name: /^(Sequence definition \(JSON\)|序列定义（JSON）)$/,
  });
  const serialized = await editor.inputValue();
  const definition = JSON.parse(serialized);
  const inputNames = ["recorded_send_1", "recorded_send_2"];
  assert.equal(definition.version, 1);
  assert.deepEqual(definition.variables, {
    recorded_send_1: null,
    recorded_send_2: null,
  });
  assert.deepEqual(
    definition.steps.map(({ kind }) => kind),
    ["send", "delay", "send"],
  );
  const steps = definition.steps.filter(({ kind }) => kind === "send");
  assert.deepEqual(
    steps.map(({ hex }) => hex),
    inputNames.map((name) => "$" + "{" + name + "}"),
  );
  assert.ok(
    !serialized.includes("3C 26") &&
      !serialized.includes("52 45 43 4F 52 44 2D 4F 4E 45"),
  );
  const originalWrites = sentBytes(
    await readRaw("manual-recording-review", before.nextEventSeq),
  );
  assert.deepEqual(originalWrites, [Buffer.from(manual), recordedSelection]);
  const run = sequence.getByRole("button", {
    name: /^(Run sequence|运行序列)$/,
  });
  const first = sequence.getByLabel(inputNames[0], { exact: true });
  const second = sequence.getByLabel(inputNames[1], { exact: true });
  const chooseSecond = sequence.getByRole("button", {
    name: /^(Choose file for recorded_send_2|为 recorded_send_2 选择文件)$/,
  });
  async function pickBinary(buffer) {
    const picked = page.waitForEvent("filechooser");
    await chooseSecond.click();
    const chooser = await picked;
    await chooser.setFiles(
      buffer === undefined
        ? []
        : {
            name: "bench-input.bin",
            mimeType: "application/octet-stream",
            buffer,
          },
    );
  }
  const bound = sequence
    .getByRole("status")
    .filter({ hasText: /Bound 4 bytes from a file|已从文件绑定 4 字节/ });
  const invalidSize = sequence
    .getByRole("status")
    .filter({ hasText: /between 1 and 256 bytes|1 至 256 字节/ });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 460, height: 640 });
  await expect(run).toBeDisabled();
  await expect(first).toHaveAttribute("type", "password");
  await expect(
    sequence.getByText(/^(Send input|发送输入) recorded_send_1$/),
  ).toBeVisible();
  await first.fill("52 45 50 4C 41 59");
  await second.fill("GG");
  await expect(run).toBeDisabled();
  await expect(
    sequence.getByRole("status").filter({ hasText: /Check HEX|检查/ }),
  ).toBeVisible();
  await second.fill("3F 2B");
  await expect(run).toBeEnabled();
  await pickBinary(replacementFile);
  await expect(bound).toBeVisible();
  await expect(second).toHaveValue("00 FF 3F 2B");
  await pickBinary(undefined);
  await expect(second).toHaveValue("00 FF 3F 2B");
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(257)]) {
    await pickBinary(invalid);
    await expect(invalidSize).toBeVisible();
    await expect(second).toHaveValue("00 FF 3F 2B");
  }
  await pickBinary(replacementFile);
  await expect(invalidSize).toHaveCount(0);
  await expect(
    sequence.getByText(/52 45 50 4C 41 59|00 FF 3F 2B|bench-input.bin/),
  ).toHaveCount(0);
  await bound.scrollIntoViewIfNeeded();
  await sequence.screenshot({
    path: join(output, "manual-reference-inputs.png"),
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sequence
      .getByRole("button", { name: /^(Download JSON|下载 JSON)$/ })
      .click(),
  ]);
  const saved = join(output, "manual-reference-sequence.json");
  await download.saveAs(saved);
  assert.equal(await readFile(saved, "utf8"), serialized);
  const unsaved = page.getByRole("dialog", {
    name: /^(Save unfinished work|保存未完成的工作)$/,
  });
  await sequence.locator("input[type=file][accept]").setInputFiles(saved);
  await unsaved
    .getByRole("button", { name: /^(Discard and continue|放弃并继续)$/ })
    .click();
  await expect(editor).toHaveValue(serialized);
  await expect(first).toHaveValue("");
  await expect(second).toHaveValue("");
  await expect(bound).toHaveCount(0);
  await expect(run).toBeDisabled();
  await first.fill("52 45 50 4C 41 59");
  await pickBinary(replacementFile);
  await expect(bound).toBeVisible();
  await run.click();
  await expect(
    sequence
      .getByRole("status")
      .filter({ hasText: /Command sequence completed\.|命令序列已完成。/ }),
  ).toBeVisible();
  const replayedWrites = sentBytes(
    await readRaw("manual-recording-replay", before.nextEventSeq),
  );
  assert.deepEqual(replayedWrites, [
    Buffer.from(manual),
    recordedSelection,
    Buffer.from("REPLAY"),
    replacementFile,
  ]);
  await expect(first).toHaveValue("");
  await expect(second).toHaveValue("");
  await sequence
    .getByRole("button", { name: /^(Close view|关闭视图)$/ })
    .click();
  await expect(sequence).toBeHidden();
  if (viewport) await page.setViewportSize(viewport);
  await receive.getByRole("radio", { name: /^(Text|文本)$/ }).click();
  return {
    sourceEvent: source.eventSeq,
    sourceHex: "3C 26",
    inputNames,
    savedContainsOnlyReferences: true,
    importClearedInputs: true,
    reboundAsExpected: true,
    selectedFileHex: replacementFile.toString("hex"),
    rejectedReplacementPreservedBinding: true,
    writeWaitMs: steps.map(({ writeWaitMs }) => writeWaitMs),
    durationBetweenWrites: definition.steps[1].milliseconds,
    cancelledPreviewTxCount: 0,
    originalWrites: originalWrites.length,
    replayedWrites: replayedWrites.length - originalWrites.length,
  };
}
