import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkManualRecording({ page, readRaw, source }) {
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
    .getByRole("button", { name: /^(Start recording|开始录制)$/ })
    .click();
  const manual = "RECORD-ONE";
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
        return Buffer.from(payload.bytesBase64, "base64").toString("utf8");
      });
  await openPreview();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(log).toBeFocused();
  assert.deepEqual(
    sentBytes(await readRaw("manual-recording-cancel", before.nextEventSeq)),
    [manual],
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
  const definition = JSON.parse(await editor.inputValue());
  assert.equal(definition.version, 1);
  assert.deepEqual(
    definition.steps.map(({ kind }) => kind),
    ["send", "delay", "send"],
  );
  const steps = definition.steps.filter(({ kind }) => kind === "send");
  assert.equal(
    Buffer.from(steps[0].hex.replaceAll(" ", ""), "hex").toString("utf8"),
    manual,
  );
  assert.equal(steps[1].hex, "3C 26");
  const originalWrites = sentBytes(
    await readRaw("manual-recording-review", before.nextEventSeq),
  );
  assert.deepEqual(originalWrites, [manual, "<&"]);

  await sequence
    .getByRole("button", { name: /^(Run sequence|运行序列)$/ })
    .click();
  await expect(sequence.getByRole("status")).toContainText(
    /Command sequence completed\.|命令序列已完成。/,
  );
  const replayedWrites = sentBytes(
    await readRaw("manual-recording-replay", before.nextEventSeq),
  );
  assert.deepEqual(replayedWrites, [manual, "<&", manual, "<&"]);
  await sequence
    .getByRole("button", { name: /^(Close view|关闭视图)$/ })
    .click();
  const unsaved = page.getByRole("dialog", {
    name: /^(Save unfinished work|保存未完成的工作)$/,
  });
  await unsaved
    .getByRole("button", { name: /^(Discard and continue|放弃并继续)$/ })
    .click();
  await expect(sequence).toBeHidden();
  await receive.getByRole("radio", { name: /^(Text|文本)$/ }).click();
  return {
    sourceEvent: source.eventSeq,
    sourceHex: steps[1].hex,
    writeWaitMs: steps.map(({ writeWaitMs }) => writeWaitMs),
    durationBetweenWrites: definition.steps[1].milliseconds,
    cancelledPreviewTxCount: 0,
    originalWrites: originalWrites.length,
    replayedWrites: replayedWrites.length - originalWrites.length,
  };
}
