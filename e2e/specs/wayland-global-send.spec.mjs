import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { $, browser } from "@wdio/globals";
import { globalSendRawReader } from "../global-send.mjs";
import { language, openDeepLink, ready } from "../helpers.mjs";
import {
  captureGlobalSendKey,
  closeShortcutHelp,
  disableGlobalSend,
  editGlobalSend,
  globalShortcutKey,
  openVirtual,
  rawRxBytes,
  sendDraft,
} from "./workbench.mjs";

const execute = promisify(execFile);
const helper = "e2e/wayland-desktop.py";
const artifactDir = join(
  process.env.SWB_E2E_WAYLAND_ARTIFACTS,
  "wayland-global-send",
);
const focusPath = join(artifactDir, "peer-focus.json");
const consent = process.env.SWB_E2E_WAYLAND_CONSENT;
const hotkey = "ctrl+shift+F9";

async function inject(...args) {
  return (await execute("xdotool", args, { timeout: 5000 })).stdout.trim();
}

function checkRaw(page, bytes) {
  const tx = page.events.filter(({ kind }) => kind === "tx");
  const intents = page.events.filter(({ kind }) => kind === "tx_intent");
  assert.equal(tx.length, 1);
  assert.equal(intents.length, 1);
  assert.equal(tx[0].payload.operationId, intents[0].payload.operationId);
  assert.equal(tx[0].payload.outcome, "accepted");
  assert.deepEqual(tx[0].payload.unknownRanges, []);
  assert.deepEqual(Buffer.from(tx[0].payload.bytesBase64, "base64"), bytes);
  assert.deepEqual(rawRxBytes(page), bytes);
}

async function assertNoTransmit(read) {
  await inject("key", hotkey);
  await delay(650);
  const page = await read();
  assert.deepEqual(
    page.events.filter(({ kind }) => kind === "tx" || kind === "tx_intent"),
    [],
  );
  return page;
}

it(`honors KDE consent ${consent} with a separate foreground Wayland client`, async () => {
  assert.equal(process.env.GDK_BACKEND, "wayland");
  assert.equal(process.env.XDG_SESSION_TYPE, "wayland");
  const outerWindow = process.env.SWB_E2E_KWIN_WINDOW;
  assert.match(outerWindow, /^\d+$/);
  assert.equal(await inject("getwindowfocus"), outerWindow);

  const payload = `SWB-WAYLAND-${randomUUID().slice(0, 8)}`;
  const bytes = Buffer.from(payload, "ascii");
  const receipt = {
    candidate: process.env.GITHUB_SHA,
    portalVersion: process.env.SWB_E2E_PORTAL_VERSION,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
  };
  let peer;
  try {
    await ready();
    await language("en");
    await openDeepLink("/");
    await openVirtual();
    const draft = await sendDraft();
    await draft.setValue(payload);

    await editGlobalSend();
    assert.equal(await (await globalShortcutKey()).getText(), "Off");
    await captureGlobalSendKey("F9");
    const decision = await execute(
      "/usr/bin/python3",
      [helper, "consent", consent],
      {
        timeout: 22000,
      },
    );
    receipt.consent = JSON.parse(decision.stdout);
    if (consent === "Cancel") {
      const status = await $("#shortcut-conflict");
      await status.waitForDisplayed();
      assert.equal(
        await status.getText(),
        "Shortcut registration was cancelled.",
      );
    } else {
      await $("#shortcut-capture").waitForExist({ reverse: true });
    }
    receipt.binding = await (await globalShortcutKey()).getText();
    if (consent === "Cancel") {
      assert.equal(receipt.binding, "Off");
      const closeEditor = await $("button=Cancel");
      await closeEditor.waitForEnabled();
      await closeEditor.click();
    } else {
      assert.match(receipt.binding, /F9$/);
    }
    await closeShortcutHelp();

    const read = await globalSendRawReader();
    peer = spawn("/usr/bin/python3", [helper, "focus", focusPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const readFocus = () => JSON.parse(readFileSync(focusPath, "utf8"));
    await browser.waitUntil(
      () => {
        try {
          const focus = readFocus();
          if (focus.pid === peer.pid && focus.active) {
            receipt.focusBefore = focus;
            return true;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return false;
      },
      { timeoutMsg: "The independent Wayland client did not get focus" },
    );
    assert.equal(receipt.focusBefore.backend, "GdkWaylandDisplay");
    assert.equal(receipt.focusBefore.display, receipt.waylandDisplay);
    assert.equal(await inject("getwindowfocus"), outerWindow);

    if (consent === "Cancel") {
      receipt.raw = await assertNoTransmit(read);
      receipt.focusAfter = readFocus();
      assert.deepEqual(receipt.focusAfter, receipt.focusBefore);
      return;
    }

    await inject("keydown", hotkey);
    try {
      await browser.waitUntil(
        async () => {
          receipt.raw = await read();
          return (
            receipt.raw.events.some(({ kind }) => kind === "tx") &&
            rawRxBytes(receipt.raw).length >= bytes.length
          );
        },
        { timeoutMsg: "The Wayland hotkey produced no Virtual Echo TX and RX" },
      );
      await delay(900);
    } finally {
      await inject("keyup", hotkey);
    }
    receipt.raw = await read();
    checkRaw(receipt.raw, bytes);
    // 保留绑定，撤下可写草稿后再用同一个系统热键核对 Host 的源尾。
    await draft.setValue("");
    await $("button[aria-label='Send']").waitForEnabled({ reverse: true });
    receipt.emptyDraft = await assertNoTransmit(await globalSendRawReader());
    receipt.focusAfter = readFocus();
    assert.deepEqual(receipt.focusAfter, receipt.focusBefore);
    peer.kill();
    peer = undefined;
    await disableGlobalSend();
    receipt.disabled = true;
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    peer?.kill();
    writeFileSync(
      join(artifactDir, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
  }
});
