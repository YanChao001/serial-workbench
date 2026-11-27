import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browser, $ } from "@wdio/globals";
import { globalSendRawReader, rawRxBytes } from "../global-send.mjs";
import { fileDropDriver } from "../file-drop-driver.mjs";

const transferSource = "[role='dialog'] output[aria-label='Source file']";
const transferRange = "[role=dialog] output[aria-label='Bytes to send']";
const transferSample =
  "[role=dialog] output[aria-label='Beginning of selected bytes']";
const commandBody = "[role='dialog'] textarea[id$='-body']";
const dialog = () => $("[role=dialog]");
const field = (caption, tag = "input") =>
  $(
    `//${tag}[@id=//label[normalize-space()='${caption}']/@for] | //label[normalize-space()='${caption}']//${tag}`,
  );

async function dialogButton(label) {
  return (await dialog()).$(`button=${label}`);
}

async function clickDialogButton(label) {
  const button = await dialogButton(label);
  await button.waitForDisplayed();
  await button.waitForEnabled();
  await button.click();
}

async function fillEditorName(name) {
  const input = await field("Name");
  await input.waitForDisplayed();
  await input.setValue(name);
}

async function waitForPreviewText(selector, expected) {
  // 中间选区无效时会卸载旧输出，合法后生成新节点。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (target, text) => document.querySelector(target)?.textContent === text,
        selector,
        expected,
      ),
    { timeoutMsg: `The file preview did not show "${expected}".` },
  );
  await (await $(selector)).scrollIntoView({ block: "nearest" });
}

async function closeDialog() {
  const current = await dialog();
  await current.$("button[data-slot='dialog-close']").click();
  const discard = await $("button=Discard and continue");
  await browser.waitUntil(
    async () => !(await current.isExisting()) || (await discard.isDisplayed()),
  );
  if (await discard.isDisplayed()) await discard.click();
  await current.waitForExist({ reverse: true });
}

const writes = ({ events }) =>
  events.filter(({ kind }) => kind === "tx" || kind === "tx_intent");

async function assertSourceStaysEmpty(source) {
  // 原生拖放到 Host 领取之间有异步回调，观察本次尝试后再开始下一次。
  const observeUntil = performance.now() + 500;
  await browser.waitUntil(
    async () => {
      assert.equal(await source.getText(), "Drop one file here");
      return performance.now() >= observeUntil;
    },
    { interval: 50 },
  );
}

export function fileDropChecks(openTool) {
  const driver = fileDropDriver();
  if (!driver) return;
  const { platform, dropFiles } = driver;
  const artifact = (name) => `${platform}-file-drop-${name}`;

  it(`receives a real ${platform} file drag for transfer and command body with explicit confirmation`, async () => {
    const directory = resolve(
      "artifacts",
      "e2e",
      process.env.STARTER_E2E_PHASE,
    );
    mkdirSync(directory, { recursive: true });
    const transferPath = join(directory, "io18-transfer.bin");
    const commandPath = join(directory, "io18-command.bin");
    writeFileSync(transferPath, Buffer.of(0, 0xfe, 0x23, 0xff));
    writeFileSync(commandPath, Buffer.of(9, 0xff, 0, 0x41));

    const readTransfer = await globalSendRawReader();
    await openTool("File transfer");
    const source = await $(transferSource);
    assert.equal(await source.getText(), "Drop one file here");
    const outside = await dropFiles("[role=dialog] [data-slot=dialog-title]", [
      transferPath,
    ]);
    await assertSourceStaysEmpty(source);
    const multiple = await dropFiles(transferSource, [
      transferPath,
      commandPath,
    ]);
    await assertSourceStaysEmpty(source);
    const transferPoint = await dropFiles(transferSource, [transferPath]);
    assert.equal(transferPoint.fileDataOffered, true);
    if (process.env.SWB_E2E_FILE_DRAG_SCALE)
      assert.equal(
        transferPoint.pixelRatio,
        Number(process.env.SWB_E2E_FILE_DRAG_SCALE),
      );
    await browser.waitUntil(
      async () => (await source.getText()) === "io18-transfer.bin",
    );
    const initialSample = await $(transferSample);
    await initialSample.waitForDisplayed();
    assert.equal(await initialSample.getText(), "0: 00 FE 23 FF");
    assert.deepEqual(writes(await readTransfer()), []);

    await (
      await dialog()
    )
      .$(".//button[@role='tab' and normalize-space()='Advanced']")
      .click();
    await waitForPreviewText(transferRange, "[0, 4) / 4");
    await (await field("Byte offset")).setValue("1");
    await (await field("Length (bytes)")).setValue("2");
    await waitForPreviewText(transferRange, "[1, 3) / 4");
    await waitForPreviewText(transferSample, "1: FE 23");
    const sample = await (await $(transferSample)).getText();
    await browser.saveScreenshot(join(directory, artifact("transfer.png")));
    assert.deepEqual(writes(await readTransfer()), []);
    const send = await (await dialog()).$("button=Send file");
    await send.waitForEnabled();
    await send.click();
    let raw;
    await browser.waitUntil(async () => {
      raw = await readTransfer();
      return (
        rawRxBytes(raw).length >= 2 &&
        raw.events.some(({ kind }) => kind === "tx")
      );
    });
    const sent = raw.events.filter(({ kind }) => kind === "tx");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.outcome, "accepted");
    assert.deepEqual(sent[0].payload.acceptedRanges, [
      { start: "0", end: "2" },
    ]);
    assert.deepEqual(sent[0].payload.unknownRanges, []);
    assert.deepEqual(rawRxBytes(raw), Buffer.of(0xfe, 0x23));
    const receipt = {
      platform,
      candidate: process.env.GITHUB_SHA,
      outside,
      multiple,
      transferPoint,
      transfer: {
        offset: 1,
        length: 2,
        sample,
        receipt: sent[0],
        echoHex: rawRxBytes(raw).toString("hex"),
      },
    };
    const receiptPath = join(directory, artifact("receipt.json"));
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    await closeDialog();

    const readCommand = await globalSendRawReader();
    const launcher = await $("button[aria-label='Command library']");
    await launcher.waitForEnabled();
    await launcher.click();
    const groupName = "System file drop";
    const commandName = "IO-18 file command";
    await clickDialogButton("New group");
    await fillEditorName(groupName);
    await clickDialogButton("Save");
    await clickDialogButton(groupName);
    await clickDialogButton("New command");
    await fillEditorName(commandName);
    const body = await $(commandBody);
    await body.waitForDisplayed();
    await body.setValue("original");
    const commandPoint = await dropFiles(commandBody, [commandPath]);
    assert.equal(commandPoint.fileDataOffered, true);
    const replace = await (await dialog()).$("button=Replace command body");
    await replace.waitForEnabled();
    assert.equal(await body.getValue(), "original");
    assert.match(await (await dialog()).getText(), /09 FF 00 41/);
    assert.deepEqual(writes(await readCommand()), []);
    await browser.saveScreenshot(join(directory, artifact("command.png")));
    await replace.click();
    assert.equal(await body.getValue(), "09 FF 00 41");
    await clickDialogButton("Save");
    // 保存后等 Host 回读到列表项，再打开核对。
    await (await dialogButton(commandName)).waitForDisplayed();
    await closeDialog();
    await launcher.waitForEnabled();
    await launcher.click();
    await clickDialogButton(groupName);
    await clickDialogButton(commandName);
    const reopenedBody = await $(commandBody);
    await reopenedBody.waitForDisplayed();
    assert.equal(await reopenedBody.getValue(), "09 FF 00 41");
    assert.deepEqual(writes(await readCommand()), []);
    await closeDialog();

    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          ...receipt,
          commandPoint,
          command: { body: "09 FF 00 41", savedAndReopened: true, writes: 0 },
        },
        null,
        2,
      ),
    );
  });
}
