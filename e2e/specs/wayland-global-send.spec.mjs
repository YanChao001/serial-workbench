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
const replacement = "ctrl+shift+F10";

async function inject(...args) {
  return (await execute("xdotool", args, { timeout: 5000 })).stdout.trim();
}

async function kdeControl(target, name, action = "click") {
  const result = await execute(
    "/usr/bin/python3",
    [helper, "control", target, name, action],
    {
      timeout: 22000,
    },
  );
  return JSON.parse(result.stdout);
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

async function assertNoTransmit(read, key = hotkey) {
  await inject("key", key);
  await delay(650);
  const page = await read();
  assert.deepEqual(
    page.events.filter(({ kind }) => kind === "tx" || kind === "tx_intent"),
    [],
  );
  return page;
}

async function exitEditor() {
  const closeEditor = await $("button=Cancel");
  await closeEditor.waitForEnabled();
  await closeEditor.click();
  await closeShortcutHelp();
}

async function startRecordingNewKey() {
  await kdeControl("settings", "Add custom shortcut");
  const capture = await kdeControl(
    "settings",
    "Cancel capturing shortcut",
    "observe",
  );
  assert.equal(
    capture.active,
    true,
    "KDE Settings must receive the key sequence",
  );
}

async function checkSystemSettings(receipt, draft, bytes) {
  assert.ok(
    Number(receipt.portalVersion) >= 2,
    "The settings scenario requires GlobalShortcuts v2",
  );
  await draft.setValue(bytes.toString("ascii"));
  await editGlobalSend();
  const systemSettings = await $("button=Open system shortcut settings");
  await systemSettings.waitForEnabled();
  await systemSettings.click();

  await startRecordingNewKey();
  receipt.cancelledEdit = await kdeControl(
    "settings",
    "Cancel capturing shortcut",
  );
  assert.equal(await (await globalShortcutKey()).getText(), receipt.binding);

  await startRecordingNewKey();
  await inject("key", "alt+F4");
  receipt.conflict = await kdeControl("conflict", "Cancel");
  assert.equal(await (await globalShortcutKey()).getText(), receipt.binding);

  await kdeControl(
    "settings",
    `Default shortcut ${receipt.binding} is enabled.`,
  );
  await startRecordingNewKey();
  await inject("key", replacement);
  receipt.applied = await kdeControl("settings", "Apply");
  await browser.waitUntil(async () => {
    receipt.changedBinding = await (await globalShortcutKey()).getText();
    return (
      /F10$/.test(receipt.changedBinding) &&
      !receipt.changedBinding.includes("F9")
    );
  });
  await exitEditor();

  const readChanged = await globalSendRawReader();
  receipt.oldKeyRaw = await assertNoTransmit(readChanged);
  receipt.settingsFocus = await kdeControl(
    "settings",
    "Add custom shortcut",
    "observe",
  );
  assert.equal(receipt.settingsFocus.active, true);
  await inject("key", replacement);
  await browser.waitUntil(async () => {
    receipt.newKeyRaw = await readChanged();
    return rawRxBytes(receipt.newKeyRaw).length >= bytes.length;
  });
  checkRaw(receipt.newKeyRaw, bytes);

  await kdeControl("settings", "Delete shortcut");
  receipt.revoke = await kdeControl("settings", "Apply");
  await editGlobalSend();
  await browser.waitUntil(
    async () => (await (await globalShortcutKey()).getText()) === "Off",
  );
  await exitEditor();
  receipt.revokedKeyRaw = await assertNoTransmit(
    await globalSendRawReader(),
    replacement,
  );
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
    receipt.consent = await kdeControl("consent", consent);
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
      await exitEditor();
    } else {
      assert.match(receipt.binding, /F9$/);
      await closeShortcutHelp();
    }

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
    const changedBytes = Buffer.from(`${payload}-UPDATED`, "ascii");
    await checkSystemSettings(receipt, draft, changedBytes);
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
}).timeout(150000);
