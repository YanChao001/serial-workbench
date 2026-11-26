import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { $, browser } from "@wdio/globals";
import {
  checkGlobalSendRaw,
  globalSendRawReader,
  rawRxBytes,
} from "../global-send.mjs";
import {
  invoke,
  language,
  navigate,
  openDeepLink,
  ready,
} from "../helpers.mjs";
import {
  captureGlobalSendKey,
  closeShortcutHelp,
  disableGlobalSend,
  editGlobalSend,
  globalShortcutKey,
  openVirtual,
  saveDrafts,
  sendDraft,
} from "./workbench.mjs";

const execute = promisify(execFile);
const helper = "e2e/wayland-desktop.py";
const artifactDir = join(
  process.env.SWB_E2E_WAYLAND_ARTIFACTS,
  "wayland-global-send",
);
const focusPath = join(artifactDir, "peer-focus.json");
const keyPath = join(artifactDir, "peer-keys.jsonl");
const portalTrace = join(
  process.env.SWB_E2E_WAYLAND_ARTIFACTS,
  "shortcuts-dbus.log",
);
const kwinTrace = join(process.env.SWB_E2E_WAYLAND_ARTIFACTS, "kwin.log");
const scenario = process.env.SWB_E2E_WAYLAND_SCENARIO;
const hotkey = "F9";
const replacement = "F10";
const keycodes = JSON.parse(process.env.SWB_E2E_WAYLAND_KEYCODES);
const registrationFailures = {
  cancel: "Shortcut registration was cancelled.",
  deny: "The system, another app, or another workbench window may be using this shortcut. Try another combination.",
  unavailable:
    "This desktop session cannot register a global shortcut. You can use the send editor shortcut.",
};

async function inject(...args) {
  return (await execute("xdotool", args, { timeout: 5000 })).stdout.trim();
}

async function withKeys(keys, held = async () => {}) {
  const codes = keys.map((key) => {
    assert.match(keycodes[key], /^\d+$/, `No X11 keycode for ${key}`);
    return keycodes[key];
  });
  try {
    await inject("keydown", ...codes);
    await held();
  } finally {
    await inject("keyup", ...codes.reverse());
  }
}

function withHotkey(key, held) {
  return withKeys(["Control_L", "Shift_L", key], held);
}

async function busCall(destination, path, method, ...args) {
  const { stdout } = await execute(
    "gdbus",
    [
      "call",
      "--session",
      "--timeout",
      "3",
      "--dest",
      destination,
      "--object-path",
      path,
      "--method",
      method,
      ...args,
    ],
    { timeout: 5000 },
  );
  return stdout.trim();
}

async function kdeComponent() {
  try {
    const reply = await busCall(
      "org.kde.kglobalaccel",
      "/kglobalaccel",
      "org.kde.KGlobalAccel.getComponent",
      process.env.SWB_E2E_WAYLAND_APP_NAME,
    );
    const path = /objectpath '([^']+)'/.exec(reply)?.[1];
    assert.ok(path, `KDE component returned no object path: ${reply}`);
    const shortcuts = await busCall(
      "org.kde.kglobalaccel",
      path,
      "org.kde.kglobalaccel.Component.allShortcutInfos",
    );
    return { path, shortcuts };
  } catch (error) {
    return { error: error.stderr?.trim() || error.message };
  }
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

async function clickSettingsCheckbox(receipt, name) {
  const control = await kdeControl("settings", name, "bounds");
  receipt.defaultPointer = { control };
  assert.equal(control.active, true);
  const marker = `swb-e2e-window-${randomUUID()}`;
  const script = join(artifactDir, `${marker}.js`);
  // Read the foreground client's origin in nested KWin. Qt exposes the item relative to it.
  writeFileSync(
    script,
    `
const active = workspace.activeWindow;
if (active) {
  const { x, y, width, height } = active.clientGeometry;
  console.log(${JSON.stringify(marker + " ")} + JSON.stringify([active.caption, x, y, width, height]));
}
`,
  );
  const loaded = await busCall(
    "org.kde.KWin",
    "/Scripting",
    "org.kde.kwin.Scripting.loadScript",
    script,
    marker,
  );
  const id = /^\((?:int32 )?(\d+),\)$/.exec(loaded)?.[1];
  assert.ok(id, `KWin could not load the window probe: ${loaded}`);
  try {
    await busCall(
      "org.kde.KWin",
      `/Scripting/Script${id}`,
      "org.kde.kwin.Script.run",
    );
    await browser.waitUntil(
      () => {
        const line = readFileSync(kwinTrace, "utf8")
          .split("\n")
          .find((value) => value.includes(`${marker} [`));
        if (!line) return false;
        const start = line.indexOf(`${marker} [`);
        receipt.defaultPointer.geometry = JSON.parse(
          line.slice(start + marker.length + 1),
        );
        return true;
      },
      {
        timeout: 5000,
        timeoutMsg: "KWin did not report the active settings window",
      },
    );
  } finally {
    await busCall(
      "org.kde.KWin",
      "/Scripting",
      "org.kde.kwin.Scripting.unloadScript",
      marker,
    );
  }
  const [title, x, y, width, height] = receipt.defaultPointer.geometry;
  const normalizeCaption = (value) => value.trim().replace(/\s+/g, " ");
  assert.equal(normalizeCaption(title), normalizeCaption(control.dialog));
  const [itemX, itemY, itemWidth, itemHeight] = control.bounds;
  assert.ok([x, y, width, height, ...control.bounds].every(Number.isFinite));
  assert.ok(itemX >= 0 && itemY >= 0 && itemWidth > 0 && itemHeight > 0);
  assert.ok(itemX + itemWidth <= width && itemY + itemHeight <= height);
  const outer = process.env.SWB_E2E_KWIN_WINDOW;
  assert.equal(await inject("getwindowfocus"), outer);
  const pointer = [
    Math.round(x + itemX + itemWidth / 2),
    Math.round(y + itemY + itemHeight / 2),
  ];
  receipt.defaultPointer.point = pointer;
  await inject(
    "mousemove",
    "--window",
    outer,
    ...pointer.map(String),
    "click",
    "1",
  );
}

async function sendFromPeer(receipt, read, bytes) {
  const before = readFileSync(portalTrace, "utf8").length;
  await withHotkey(hotkey, async () => {
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
  });
  receipt.raw = await read();
  const component =
    receipt.componentAfter?.path ?? receipt.componentBefore?.path;
  receipt.kwinRepeat = readFileSync(portalTrace, "utf8")
    .slice(before)
    .split("\n")
    .filter((line) =>
      line.endsWith(
        `path=${component}; interface=org.kde.kglobalaccel.Component; member=globalShortcutRepeated`,
      ),
    );
  assert.ok(
    receipt.kwinRepeat.length > 0,
    "KWin did not repeat the held shortcut",
  );
  checkGlobalSendRaw(receipt.raw, bytes);
}

async function observeRepeatBinding(receipt, readFocus, bytes) {
  const comparison = (receipt.repeatBinding = {});
  try {
    await disableGlobalSend();
    comparison.componentBefore = await kdeComponent();
    await editGlobalSend();
    await captureGlobalSendKey(hotkey);
    await $("#shortcut-capture").waitForExist({ reverse: true });
    comparison.binding = await (await globalShortcutKey()).getText();
    assert.equal(comparison.binding, receipt.binding);
    await closeShortcutHelp();
    assert.deepEqual(readFocus(), receipt.focusBefore);
    await sendFromPeer(comparison, await globalSendRawReader(), bytes);
  } catch (error) {
    comparison.failure = error.message;
  }
}

function checkNoTransmit(page) {
  assert.deepEqual(
    page.events.filter(({ kind }) => kind === "tx" || kind === "tx_intent"),
    [],
  );
}

async function assertNoTransmit(read, key = hotkey) {
  await withHotkey(key);
  await delay(650);
  const page = await read();
  checkNoTransmit(page);
  return page;
}

async function recordPress(receipt, name, read, bytes, key = hotkey) {
  await withHotkey(key);
  await browser.waitUntil(async () => {
    receipt[name] = await read();
    return rawRxBytes(receipt[name]).length >= bytes.length;
  });
  checkGlobalSendRaw(receipt[name], bytes);
}

async function exitEditor() {
  const closeEditor = await $("button=Cancel");
  await closeEditor.waitForEnabled();
  await closeEditor.click();
  await closeShortcutHelp();
}

async function checkWorkbenchTarget(receipt, bytes) {
  const focused = () => browser.execute(() => document.hasFocus());
  await browser.waitUntil(focused, {
    timeoutMsg: "The workbench did not regain focus after the portal dialog",
  });
  await recordPress(
    receipt,
    "workbenchFocusedRaw",
    await globalSendRawReader(),
    bytes,
  );
  receipt.workbenchKeptFocus = await focused();
  assert.equal(receipt.workbenchKeptFocus, true);

  await editGlobalSend();
  try {
    assert.equal(await (await globalShortcutKey()).getText(), receipt.binding);
    receipt.shortcutHelpRaw = await assertNoTransmit(
      await globalSendRawReader(),
    );
  } finally {
    await exitEditor();
  }

  await navigate("/settings");
  try {
    await $("#settings-language").waitForDisplayed();
    receipt.settingsPageRaw = await assertNoTransmit(
      await globalSendRawReader(),
    );
  } finally {
    await navigate("/");
  }
  const draft = await sendDraft();
  await draft.waitForDisplayed();
  assert.equal(await draft.getValue(), bytes.toString("ascii"));
}

async function checkSecondaryTarget(receipt) {
  const main = await browser.getWindowHandle();
  const read = await globalSendRawReader();
  assert.deepEqual(await browser.getWindowHandles(), [main]);
  const newWindow = await $("button[aria-label='New window']");
  await newWindow.waitForEnabled();
  await newWindow.click();
  let secondary;
  try {
    await browser.waitUntil(async () => {
      secondary = (await browser.getWindowHandles()).find(
        (handle) => handle !== main,
      );
      return secondary !== undefined;
    });
    await browser.switchToWindow(secondary);
    await ready("secondary");
    const focused = () => browser.execute(() => document.hasFocus());
    await browser.waitUntil(focused, {
      timeoutMsg: "The secondary WebView did not take focus",
    });
    await withHotkey(hotkey);
    await delay(650);
    receipt.secondaryKeptFocus = await focused();
    assert.equal(receipt.secondaryKeptFocus, true);
  } finally {
    await browser.switchToWindow(main);
    if (secondary) {
      const closed = await invoke("plugin:window|close", {
        label: "secondary",
      });
      assert.equal(closed.ok, true, JSON.stringify(closed.failure));
      await browser.waitUntil(
        async () => !(await browser.getWindowHandles()).includes(secondary),
      );
    }
  }
  receipt.secondaryRaw = await read();
  checkNoTransmit(receipt.secondaryRaw);
}

async function confirmPortalClose(receipt) {
  await browser.waitUntil(
    () => {
      const lines = readFileSync(portalTrace, "utf8").split("\n");
      const request = lines.findIndex((line) =>
        /path=\/org\/freedesktop\/portal\/desktop\/request\/\d+_\d+\/bind_send_shortcut; interface=org\.freedesktop\.portal\.Request; member=Close$/.test(
          line,
        ),
      );
      if (request < 0) return false;
      const owner = /sender=:(\d+\.\d+) /.exec(lines[request])?.[1];
      if (!owner) return false;
      const sessionPath = `/org/freedesktop/portal/desktop/session/${owner.replace(".", "_")}/send_shortcut`;
      const session = lines
        .slice(request + 1)
        .find(
          (line) =>
            line.includes(`sender=:${owner} `) &&
            line.endsWith(
              `path=${sessionPath}; interface=org.freedesktop.portal.Session; member=Close`,
            ),
        );
      if (!session) return false;
      receipt.portalClose = [lines[request], session];
      return true;
    },
    {
      timeout: 5000,
      timeoutMsg:
        "The old document did not close its portal request and session",
    },
  );
}

async function settleConsent(receipt, payload) {
  if (scenario === "reload") {
    receipt.pending = await kdeControl("consent", "Cancel", "observe");
    receipt.documentBefore = await browser.execute(
      () => performance.timeOrigin,
    );
    await browser.execute(() => {
      // Ask the current WebView to reload after this script response has returned.
      window.setTimeout(() => window.location.reload(), 100);
    });
    receipt.dismissed = await kdeControl("consent", "Cancel", "wait-closed");
    await ready();
    receipt.documentAfter = await browser.execute(() => performance.timeOrigin);
    assert.notEqual(receipt.documentAfter, receipt.documentBefore);
    await confirmPortalClose(receipt);
    await openDeepLink("/");
    const closeSession = await $("button[aria-label='Close session']");
    if (
      !(await closeSession.isDisplayed()) ||
      !(await closeSession.isEnabled())
    ) {
      await openVirtual();
    }
    const restored = await sendDraft();
    await browser.waitUntil(async () => {
      receipt.restoredDraft = await restored.getValue();
      return receipt.restoredDraft === payload;
    });
    await editGlobalSend();
    return;
  }

  if (scenario === "unavailable") {
    assert.equal(receipt.portalVersion, "0");
  } else {
    if (scenario === "deny") {
      receipt.cleared = await kdeControl("consent", "Clear Key Sequence");
    }
    receipt.consent = await kdeControl(
      "consent",
      scenario === "cancel" ? "Cancel" : "OK",
    );
  }
  const expectedStatus = registrationFailures[scenario];
  if (expectedStatus) {
    const status = await $("#shortcut-conflict");
    await status.waitForDisplayed();
    receipt.registrationStatus = await status.getText();
    assert.equal(receipt.registrationStatus, expectedStatus);
  } else {
    await $("#shortcut-capture").waitForExist({ reverse: true });
  }
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
  const portalVersion = Number(receipt.portalVersion);
  assert.ok(
    portalVersion >= 1,
    "The settings scenario requires the GlobalShortcuts portal",
  );
  await draft.setValue(bytes.toString("ascii"));
  await editGlobalSend();
  const systemSettings = await $("button=Open system shortcut settings");
  if (portalVersion === 1) {
    const help = await $("#shortcut-system-help");
    await help.waitForDisplayed();
    receipt.manualSettingsHint = await help.getText();
    assert.equal(
      receipt.manualSettingsHint,
      "Change this shortcut in your desktop’s shortcut settings.",
    );
    assert.equal(await systemSettings.isExisting(), false);
    await execute("xdg-open", ["systemsettings://kcm_keys"], { timeout: 5000 });
  } else {
    await systemSettings.waitForEnabled();
    await systemSettings.click();
    // ConfigureShortcuts closes the capture editor after the portal replies.
    await $("#shortcut-capture").waitForExist({ reverse: true });
  }

  receipt.settingsComponent = await kdeControl(
    "settings",
    process.env.SWB_E2E_WAYLAND_APP_NAME,
  );
  await startRecordingNewKey();
  receipt.cancelledEdit = await kdeControl(
    "settings",
    "Cancel capturing shortcut",
  );
  assert.equal(await (await globalShortcutKey()).getText(), receipt.binding);

  await startRecordingNewKey();
  await withKeys(["Alt_L", "F4"]);
  receipt.conflict = await kdeControl("conflict", "Cancel");
  assert.equal(await (await globalShortcutKey()).getText(), receipt.binding);

  await startRecordingNewKey();
  await withHotkey(replacement);
  await clickSettingsCheckbox(
    receipt,
    `Default shortcut ${receipt.binding} is enabled.`,
  );
  receipt.defaultDisabled = await kdeControl(
    "settings",
    `Default shortcut ${receipt.binding} is disabled.`,
    "observe",
  );
  receipt.applied = await kdeControl("settings", "Apply");
  await browser.waitUntil(async () => {
    receipt.changedBinding = await (await globalShortcutKey()).getText();
    return (
      /F10$/.test(receipt.changedBinding) &&
      !receipt.changedBinding.includes("F9")
    );
  });
  const closeHelp = await $(
    "[role=dialog][data-state=open] button[data-slot=dialog-close]",
  );
  await closeHelp.waitForEnabled();
  await closeHelp.click();
  await closeHelp.waitForExist({ reverse: true });
  const readChanged = await globalSendRawReader();
  receipt.settingsFocus = await kdeControl(
    "settings",
    "Add custom shortcut",
    "observe",
  );
  assert.equal(receipt.settingsFocus.active, true);
  receipt.oldKeyRaw = await assertNoTransmit(readChanged);
  await recordPress(receipt, "newKeyRaw", readChanged, bytes, replacement);
  receipt.settingsFocusAfter = await kdeControl(
    "settings",
    "Add custom shortcut",
    "observe",
  );
  assert.equal(receipt.settingsFocusAfter.active, true);

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

async function peerInput(key) {
  let events;
  await browser.waitUntil(
    () => {
      events = readFileSync(keyPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.key === key && event.control && event.shift);
      return ["down", "up"].every((edge) =>
        events.some((event) => event.edge === edge),
      );
    },
    {
      timeoutMsg: `The independent Wayland client did not receive Control+Shift+${key}`,
    },
  );
  return events;
}

it(`honors the ${scenario} shortcut decision with a separate foreground Wayland client`, async () => {
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
    scenario,
  };
  let peer;
  try {
    await ready();
    await language("en");
    await openDeepLink("/");
    await openVirtual();
    const draft = await sendDraft();
    await draft.setValue(payload);
    if (scenario === "reload") {
      // Keep the production beforeunload guard enabled and reload saved work.
      await saveDrafts();
      receipt.savedDraft = await draft.getValue();
      assert.equal(receipt.savedDraft, payload);
    }

    await editGlobalSend();
    assert.equal(await (await globalShortcutKey()).getText(), "Off");
    receipt.componentBefore = await kdeComponent();
    await captureGlobalSendKey("F9");
    await settleConsent(receipt, payload);
    receipt.componentAfter = await kdeComponent();
    receipt.binding = await (await globalShortcutKey()).getText();
    if (scenario !== "approve") {
      assert.equal(receipt.binding, "Off");
      await exitEditor();
    } else {
      assert.match(receipt.binding, /F9$/);
      await closeShortcutHelp();
    }

    const failures = [];
    if (scenario === "approve") {
      try {
        await checkWorkbenchTarget(receipt, bytes);
      } catch (error) {
        failures.push(`Workbench target: ${error.message}`);
      }
      try {
        await checkSecondaryTarget(receipt);
      } catch (error) {
        failures.push(`Secondary window: ${error.message}`);
      }
    }
    const read = await globalSendRawReader();
    peer = spawn("/usr/bin/python3", [helper, "focus", focusPath, keyPath], {
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

    if (scenario !== "approve") {
      receipt.raw = await assertNoTransmit(read);
      receipt.unboundKey = await peerInput(hotkey);
      receipt.focusAfter = readFocus();
      assert.deepEqual(receipt.focusAfter, receipt.focusBefore);
      if (scenario === "unavailable") {
        const send = await $("button[aria-label='Send']");
        await send.waitForEnabled();
        await send.click();
        await browser.waitUntil(async () => {
          receipt.manualRaw = await read();
          return rawRxBytes(receipt.manualRaw).length >= bytes.length;
        });
        checkGlobalSendRaw(receipt.manualRaw, bytes);
      }
      return;
    }

    try {
      await withHotkey("F8");
      receipt.controlKeys = await peerInput("F8");
    } catch (error) {
      failures.push(`Peer input control: ${error.message}`);
    }
    try {
      await sendFromPeer(receipt, read, bytes);
      await recordPress(
        receipt,
        "secondPress",
        await globalSendRawReader(),
        bytes,
      );
      // 保留绑定，撤下可写草稿后再用同一个系统热键核对 Host 的源尾。
      await draft.setValue("");
      await $("button[aria-label='Send']").waitForEnabled({ reverse: true });
      receipt.emptyDraft = await assertNoTransmit(await globalSendRawReader());
      receipt.focusAfter = readFocus();
      assert.deepEqual(receipt.focusAfter, receipt.focusBefore);
    } catch (error) {
      failures.push(`Initial dispatch: ${error.message}`);
      if (receipt.raw?.events.length === 0 && receipt.controlKeys) {
        await observeRepeatBinding(receipt, readFocus, bytes);
      }
    }
    try {
      assert.deepEqual(readFocus(), receipt.focusBefore);
      // 一项由 KWin 自身处理的快捷键证明合成输入经过了桌面的全局过滤器。
      await withKeys(["Alt_L", "F4"]);
      await browser.waitUntil(() => peer.exitCode === 0, {
        timeout: 3000,
        timeoutMsg:
          "KWin did not close the independent Wayland window for Alt+F4",
      });
      receipt.kwinCloseWindow = true;
    } catch (error) {
      failures.push(`KWin built-in shortcut: ${error.message}`);
    } finally {
      peer.kill();
      peer = undefined;
    }
    const changedBytes = Buffer.from(`${payload}-UPDATED`, "ascii");
    try {
      await checkSystemSettings(receipt, draft, changedBytes);
    } catch (error) {
      failures.push(`KDE settings: ${error.message}`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
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
