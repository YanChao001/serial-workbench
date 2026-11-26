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
const artifactDir = join("artifacts", "e2e", "wayland-global-send");
const focusPath = join(artifactDir, "peer-focus.json");

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

it("binds through the real KDE portal and sends once from a different Wayland window", async () => {
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
    const accepted = await execute(
      "/usr/bin/python3",
      [helper, "consent", "OK"],
      {
        timeout: 22000,
      },
    );
    receipt.consent = JSON.parse(accepted.stdout);
    await $("#shortcut-capture").waitForExist({ reverse: true });
    receipt.binding = await (await globalShortcutKey()).getText();
    assert.match(receipt.binding, /F9$/);
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

    const key = "ctrl+shift+F9";
    await inject("keydown", key);
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
      await inject("keyup", key);
    }
    receipt.raw = await read();
    checkRaw(receipt.raw, bytes);
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
