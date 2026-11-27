import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browser, $ } from "@wdio/globals";
import { globalSendRawReader, rawRxBytes } from "../global-send.mjs";
import { dropFilesOnX11 } from "../x11-file-drop.mjs";

const transferSource = "[role='dialog'] output[aria-label='Source file']";
const transferSample =
  "[role=dialog] output[aria-label='Beginning of selected bytes']";
const commandBody = "[role='dialog'] textarea[id$='-body']";
const dialog = () => $("[role=dialog]");
const field = (caption, tag = "input") =>
  $(
    `//${tag}[@id=//label[normalize-space()='${caption}']/@for] | //label[normalize-space()='${caption}']//${tag}`,
  );

async function closeDialog() {
  const current = await dialog();
  await current.$("button[aria-label='Close view']").click();
  const discard = await $("button=Discard and continue");
  await browser.waitUntil(
    async () => !(await current.isExisting()) || (await discard.isDisplayed()),
  );
  if (await discard.isDisplayed()) await discard.click();
  await current.waitForExist({ reverse: true });
}

const writes = ({ events }) =>
  events.filter(({ kind }) => kind === "tx" || kind === "tx_intent");

export function fileDropChecks(openTool) {
  if (process.platform !== "linux" || !process.env.SWB_E2E_X11_FILE_DRAG)
    return;

  it("receives a real X11 file drag for transfer and command body with explicit confirmation", async () => {
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
    const outside = await dropFilesOnX11(
      "[role=dialog] [data-slot=dialog-title]",
      [transferPath],
    );
    assert.equal(await source.getText(), "Drop one file here");
    const multiple = await dropFilesOnX11(transferSource, [
      transferPath,
      commandPath,
    ]);
    assert.equal(await source.getText(), "Drop one file here");
    const transferPoint = await dropFilesOnX11(transferSource, [transferPath]);
    assert.equal(transferPoint.urisOffered, true);
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
    const range = await $("[role=dialog] output[aria-label='Bytes to send']");
    assert.equal(await range.getText(), "[0, 4) / 4");
    await (await field("Byte offset")).setValue("1");
    await (await field("Length (bytes)")).setValue("2");
    assert.equal(await range.getText(), "[1, 3) / 4");
    const preview = await $(transferSample);
    await browser.waitUntil(
      async () => (await preview.getText()) === "1: FE 23",
    );
    const sample = await preview.getText();
    await preview.scrollIntoView({ block: "nearest" });
    await browser.saveScreenshot(join(directory, "x11-file-drop-transfer.png"));
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
    await closeDialog();

    const readCommand = await globalSendRawReader();
    const launcher = await $("button[aria-label='Command library']");
    await launcher.waitForEnabled();
    await launcher.click();
    await (await dialog()).$("button=New group").click();
    await (await field("Name")).setValue("System file drop");
    await (await dialog()).$("button=Save").click();
    const group = await (await dialog()).$("button=System file drop");
    await group.waitForDisplayed();
    await group.click();
    await (await dialog()).$("button=New command").click();
    await (await field("Name")).setValue("IO-18 file command");
    const body = await $(commandBody);
    await body.setValue("original");
    const commandPoint = await dropFilesOnX11(commandBody, [commandPath]);
    assert.equal(commandPoint.urisOffered, true);
    const replace = await (await dialog()).$("button=Replace command body");
    await replace.waitForEnabled();
    assert.equal(await body.getValue(), "original");
    assert.match(await (await dialog()).getText(), /09 FF 00 41/);
    assert.deepEqual(writes(await readCommand()), []);
    await browser.saveScreenshot(join(directory, "x11-file-drop-command.png"));
    await replace.click();
    assert.equal(await body.getValue(), "09 FF 00 41");
    const save = await (await dialog()).$("button=Save");
    await save.click();
    await save.waitForEnabled({ reverse: true });
    await closeDialog();
    await launcher.click();
    const reopenedGroup = await (await dialog()).$("button=System file drop");
    await reopenedGroup.waitForDisplayed();
    await reopenedGroup.click();
    await (await dialog()).$("button=IO-18 file command").click();
    await browser.waitUntil(
      async () => (await (await $(commandBody)).getValue()) === "09 FF 00 41",
    );
    assert.deepEqual(writes(await readCommand()), []);
    await closeDialog();

    writeFileSync(
      join(directory, "x11-file-drop-receipt.json"),
      JSON.stringify(
        {
          platform: "x11",
          candidate: process.env.GITHUB_SHA,
          outside,
          multiple,
          transferPoint,
          commandPoint,
          transfer: {
            offset: 1,
            length: 2,
            sample,
            receipt: sent[0],
            echoHex: rawRxBytes(raw).toString("hex"),
          },
          command: { body: "09 FF 00 41", savedAndReopened: true, writes: 0 },
        },
        null,
        2,
      ),
    );
  });
}
