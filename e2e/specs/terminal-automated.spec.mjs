import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { language, navigate, openDeepLink, ready } from "../helpers.mjs";
import { hostQuery, nativeValue } from "../settings.mjs";
import { openVirtual } from "./workbench.mjs";
import {
  button,
  byText,
  click,
  dialogButton,
  installPlugin,
  selectWindowsFile,
  sendHex,
  showPluginDetails,
  trustAndEnablePlugin,
} from "./reference-plugin.mjs";

const execute = promisify(execFile);
const directory = process.env.STARTER_E2E_TERMINAL_DIR;
const useWindowsPickers = process.env.SWB_E2E_WINDOWS_NATIVE_PICKERS === "1";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const file = (name) => join(directory, name);

const showTerminalDetails = () => showPluginDetails("Serial Monitor");

async function selectFile(element, action, path) {
  if (!useWindowsPickers) {
    await click(element);
    return;
  }
  const evidence = await selectWindowsFile(element, action, path);
  if (action === "Save") {
    assert.equal(
      evidence.owner,
      readJson(file("native-picker-open.json")).owner,
    );
  }
  writeFileSync(
    file(`native-picker-${action.toLowerCase()}.json`),
    JSON.stringify(evidence, null, 2),
    { flag: "wx" },
  );
}

async function verifyNativeDiagnosticsExport(owner) {
  await openDeepLink("/diagnostics");
  await expectCommittedLanguage("zh");
  const save = $("[data-testid=diagnostics-save]");
  await save.waitForEnabled();
  const preview = await browser.execute(() => ({
    text:
      document.querySelector('main details pre code[data-language="json"]')
        ?.textContent ?? null,
    route: location.hash,
    disclosures: document.querySelectorAll("main details").length,
    blocks: document.querySelectorAll("main pre code").length,
  }));
  assert.ok(
    preview.text,
    `Missing diagnostics report in ${JSON.stringify(preview)}`,
  );
  const { text } = preview;
  const report = JSON.parse(text);
  assert.equal(report.formatVersion, "0.1");
  assert.equal(report.platform, "windows");
  assert.equal(report.configuration.language, "zh");
  assert.match(report.recentLogs, /Application started v/);

  const output = file("diagnostics.json");
  const picker = await selectWindowsFile(
    save,
    "Save",
    output,
    "serial-workbench-diagnostics.json",
    async () => {
      const activation = await browser.execute(() => {
        const button = document.querySelector(
          'main [data-testid="diagnostics-save"]',
        );
        if (!(button instanceof HTMLButtonElement)) return "absent";
        if (button.disabled) return "disabled";
        button.click();
        return "activated";
      });
      assert.equal(
        activation,
        "activated",
        "The diagnostics report must expose its enabled save control",
      );
    },
  );
  assert.equal(picker.owner, owner);
  await browser.waitUntil(() => existsSync(output), {
    timeoutMsg: "The diagnostics export did not publish its JSON file",
  });
  const exported = readFileSync(output);
  assert.deepEqual(exported, Buffer.from(text, "utf8"));
  writeFileSync(
    file("diagnostics-export.json"),
    JSON.stringify({
      picker,
      formatVersion: report.formatVersion,
      bytes: exported.length,
      sha256: createHash("sha256").update(exported).digest("hex"),
    }),
    { flag: "wx" },
  );
  unlinkSync(output);
}

function windowEvents() {
  const log = file("terminal-automated/native.log");
  if (!existsSync(log)) return [];
  return Array.from(
    readFileSync(log, "utf8").matchAll(
      /e2e_terminal view=(node-view-[\w-]+) event=(shown|closed|stopped|withdrawn|rx|ack) position=(\d+) rx_bytes=(\d+) digest=([0-9a-f]{64}|-)/g,
    ),
    ([, view, event, position, bytes, digest]) => ({
      view,
      event,
      position: BigInt(position),
      bytes: Number(bytes),
      digest,
    }),
  );
}

function windowsZoomEvents(window) {
  return Array.from(
    readFileSync(file("terminal-automated/native.log"), "utf8").matchAll(
      /e2e_webview_zoom window=([\w-]+) handle=(\d+) factor=(\d+(?:\.\d+)?)/g,
    ),
    ([, label, handle, factor]) => ({
      label,
      handle,
      factor: Number(factor),
    }),
  ).filter((event) => event.label === window);
}

async function currentWindowsZoom(window) {
  let baseline;
  await browser.waitUntil(
    () => Boolean((baseline = windowsZoomEvents(window).at(-1))),
    {
      timeoutMsg: `No initial WebView2 zoom was recorded for ${window}`,
    },
  );
  return baseline;
}

function driveWindowsView(action, handle, ...args) {
  return execute(
    process.env.SWB_E2E_WINDOWS_PICKER_BIN,
    [process.env.STARTER_E2E_APP_PID, action, handle, ...args],
    { windowsHide: true, timeout: 15000 },
  );
}

async function verifyWindowsZoom(window, screenshots = false) {
  if (!useWindowsPickers) return;
  const baseline = await currentWindowsZoom(window);
  const drive = (action, ...args) =>
    driveWindowsView(action, baseline.handle, ...args);
  if (screenshots) await drive("ZoomCapture", file("terminal-before-zoom.png"));
  await drive("ZoomIn");
  let magnified;
  await browser.waitUntil(
    () => {
      magnified = windowsZoomEvents(window).at(-1);
      return magnified.factor > baseline.factor;
    },
    { timeoutMsg: `Ctrl+= did not magnify the foreground ${window} WebView2` },
  );
  if (screenshots) await drive("ZoomCapture", file("terminal-after-zoom.png"));
  await drive("ZoomReset");
  let restored;
  await browser.waitUntil(
    () => {
      restored = windowsZoomEvents(window).at(-1);
      return restored.factor === baseline.factor;
    },
    { timeoutMsg: `Ctrl+0 did not restore the foreground ${window} WebView2` },
  );
  writeFileSync(
    file(`zoom-${window}.json`),
    JSON.stringify({ baseline, magnified, restored }, null, 2),
    { flag: "wx" },
  );
}

async function waitEvent(predicate, timeoutMsg) {
  let match;
  await browser.waitUntil(
    () => Boolean((match = windowEvents().find(predicate))),
    { timeoutMsg },
  );
  return match;
}

async function expectNativeLocale(view, locale) {
  await browser.waitUntil(
    () =>
      readFileSync(file("terminal-automated/native.log"), "utf8").includes(
        `e2e_node_view_locale view=${view} locale=${locale}`,
      ),
    { timeoutMsg: `The current Wry shell did not apply ${locale}` },
  );
}

async function expectCommittedLanguage(language) {
  await browser.waitUntil(
    async () =>
      (await nativeValue("get_diagnostics_report")).configuration?.language ===
      language,
    { timeoutMsg: `Desktop settings did not commit ${language}` },
  );
}

async function openPlugin(label = "Open plugin") {
  await showTerminalDetails();
  const previousViews = new Set(windowEvents().map((entry) => entry.view));
  await click(button(label));
  const { view } = await waitEvent(
    (entry) => entry.event === "shown" && !previousViews.has(entry.view),
    "The native plugin window was not shown",
  );
  await button(label).waitForEnabled();
  return view;
}

async function closePlugin(view) {
  await nativeValue("host_close_node_view", { id: view });
  await waitEvent(
    (entry) => entry.view === view && entry.event === "closed",
    "The native Wry window was not destroyed",
  );
}

async function setTheme(dark) {
  const isDark = () =>
    browser.execute(() => document.documentElement.classList.contains("dark"));
  if ((await isDark()) !== dark) {
    await click($("button[data-theme-control]"));
    await browser.waitUntil(async () => (await isDark()) === dark);
  }
}

async function expectAcknowledgedRx(view, ...writes) {
  const expected = Buffer.concat(
    writes.map((write) => Buffer.from(write, "hex")),
  );
  const digest = createHash("sha256").update(expected).digest("hex");
  await browser.waitUntil(
    () => {
      const events = windowEvents().filter((entry) => entry.view === view);
      const acknowledged = events.filter(
        (entry) =>
          entry.event === "rx" &&
          events.some(
            (ack) => ack.event === "ack" && ack.position >= entry.position,
          ),
      );
      const received = acknowledged.reduce(
        (total, entry) => total + entry.bytes,
        0,
      );
      assert.ok(
        received <= expected.length,
        "The renderer acknowledged duplicate or extra RX",
      );
      if (received < expected.length) {
        assert.ok(
          !events.some((entry) => entry.event === "stopped"),
          "The plugin view stopped before acknowledging all RX. See the native log for its reason.",
        );
        return false;
      }
      assert.equal(acknowledged.at(-1)?.digest, digest);
      return true;
    },
    {
      timeoutMsg: `The isolated frame did not acknowledge ${expected.length} RX bytes`,
    },
  );
}

const captureButton = () => $("button[aria-label='Capture']");

async function readerBytes() {
  const result = await hostQuery("host.metrics", "host");
  assert.equal(result.kind, "host_metrics");
  return BigInt(result.value.reader.usedBytes);
}

async function startCapture(capturePath) {
  await click(captureButton());
  await selectFile(dialogButton("Start capture"), "Save", capturePath);
  await grantActiveOutputRead(capturePath);
  await dialogButton("Stop capture").waitForEnabled();
  await browser.keys(Key.Escape);
  await $("[role='dialog']").waitForDisplayed({ reverse: true });
  assert.equal(await captureButton().getAttribute("aria-pressed"), "true");
}

async function grantActiveOutputRead(capturePath) {
  const { hostId } = readJson(file("terminal-host.json"));
  const profile = process.env.SWB_PROFILE;
  const cli = process.env.STARTER_E2E_TERMINAL_CLI;
  assert.equal(
    profile,
    join(process.env.STARTER_E2E_DATA_ROOT, "host-profile"),
  );
  const comparable = (path) =>
    process.platform === "win32"
      ? normalize(path.replace(/^\\\\\?\\/, "")).toLowerCase()
      : normalize(path);
  // Inspect only the private fixture. The permission itself uses the normal local control API.
  const db = new DatabaseSync(join(profile, "host-v0", "state.sqlite3"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const targets = db.prepare(
      `SELECT id, json_extract(value_json,'$.path') AS path FROM documents
      WHERE id LIKE 'ref:file-%' AND json_extract(value_json,'$.purpose') = 'capture_target'`,
    );
    const activeRecording = db.prepare(
      `SELECT operation_id FROM operations WHERE terminal = 0
        AND json_extract(operation_json,'$.actionId') = 'capture.start'
        AND json_extract(operation_json,'$.state') = 'running'
        AND json_type(operation_json,'$.result') = 'object'
        AND json_extract(operation_json,'$.target.id') = ?`,
    );
    let id;
    let recording;
    // Stop controls require a readable result. Observe the active writer before granting that read.
    await browser.waitUntil(
      () => {
        const matches = targets
          .all()
          .filter((row) => comparable(row.path) === comparable(capturePath));
        assert.ok(matches.length <= 1, "More than one matching capture target");
        id = matches[0]?.id.slice("ref:".length);
        recording = id && activeRecording.get(id);
        return Boolean(recording);
      },
      { timeoutMsg: "The selected target did not start recording" },
    );
    const params = file("active-read-grant.json");
    writeFileSync(
      params,
      JSON.stringify({
        clientId: "desktop",
        permissions: ["content.read"],
        targets: [{ hostId, kind: "file", id }],
      }),
      { flag: "wx" },
    );
    const { stdout } = await execute(
      cli,
      ["authorize", "--params-json", params, "--profile", profile, "--json"],
      { windowsHide: true, timeout: 15000 },
    );
    const reply = JSON.parse(stdout);
    assert.equal(reply.ok, true);
    const grant = reply.result.operation.operationId;
    const state = db.prepare(
      "SELECT json_extract(operation_json,'$.state') AS state FROM operations WHERE operation_id = ?",
    );
    await browser.waitUntil(() => state.get(grant)?.state === "succeeded");
    assert.equal(state.get(recording.operation_id)?.state, "running");
    writeFileSync(
      file("active-read-settlement.json"),
      JSON.stringify({
        grant,
        recording: recording.operation_id,
        state: "running",
      }),
      { flag: "wx" },
    );
  } finally {
    db.close();
  }
}

async function send(hex) {
  await sendHex(hex);
  assert.equal(await captureButton().getAttribute("aria-pressed"), "true");
}

describe("Signed terminal on the real desktop", () => {
  it("installs, records across view close and reopen, and stops delivery on revocation", async function () {
    this.timeout(180000);
    const fixture = readJson(file("terminal-inputs.json"));
    const { beforeClose, whileClosed, afterReopen } = fixture.writes;
    await ready();
    await language("en");
    if (useWindowsPickers) await setTheme(true);
    await navigate("/");
    await openVirtual();
    await installPlugin(fixture, selectFile);
    await navigate("/");
    await startCapture(fixture.capture);
    const baseline = await readerBytes();

    await verifyWindowsZoom("main");
    const first = await openPlugin();
    await send(beforeClose);
    await expectAcknowledgedRx(first, beforeClose);
    const open = await readerBytes();
    assert.ok(open > baseline, "The native view must own a separate reader");
    await closePlugin(first);
    let closed;
    await browser.waitUntil(
      async () => (closed = await readerBytes()) <= baseline,
      {
        timeoutMsg: "Closing the window did not release its Host reader budget",
      },
    );
    writeFileSync(
      file("reader-close.json"),
      JSON.stringify({
        view: first,
        baseline: String(baseline),
        open: String(open),
        closed: String(closed),
      }),
      { flag: "wx" },
    );
    await send(whileClosed);
    const second = await openPlugin();
    await expectAcknowledgedRx(second, beforeClose, whileClosed);
    await verifyWindowsZoom(second, true);
    await language("zh");
    await expectCommittedLanguage("zh");
    await expectNativeLocale(second, "zh-CN");
    await language("en");
    await expectCommittedLanguage("en");
    await expectNativeLocale(second, "en");
    await send(afterReopen);
    await expectAcknowledgedRx(second, beforeClose, whileClosed, afterReopen);

    await click(captureButton());
    await click(dialogButton("Stop capture"));
    await byText(
      "*",
      "Recording complete",
      "//*[@role='dialog']",
    ).waitForDisplayed();
    await browser.keys(Key.Escape);
    await $("[role='dialog']").waitForDisplayed({ reverse: true });
    await browser.waitUntil(() => captureButton().isFocused(), {
      timeoutMsg: "Closing recording details did not restore capture focus",
    });
    await showTerminalDetails();
    const { generation } = await nativeValue("host_attachment");
    assert.ok(
      !windowEvents().some(
        (entry) =>
          entry.view === second &&
          ["withdrawn", "stopped", "closed"].includes(entry.event),
      ),
      "The reopened reader must stay live until revocation",
    );
    const actions = button("More actions");
    await click(actions);
    await browser.waitUntil(() => actions.isFocused(), {
      timeoutMsg: "The plugin actions button did not receive keyboard focus",
    });
    await browser.keys(Key.ArrowDown);
    await browser.waitUntil(
      async () => (await actions.getAttribute("aria-expanded")) === "true",
      { timeoutMsg: "The focused plugin actions menu did not open" },
    );
    await click(byText("*[@role='menuitem']", "Remove plugin trust"));
    await click(dialogButton("Remove plugin trust"));
    await button("Trust this plugin").waitForDisplayed();
    await button("Open plugin").waitForDisplayed({ reverse: true });
    await waitEvent(
      (entry) => entry.view === second && entry.event === "withdrawn",
      "The Host did not withdraw access to the old view",
    );
    await waitEvent(
      (entry) => entry.view === second && entry.event === "stopped",
      "The isolated reader did not stop after revocation",
    );
    await closePlugin(second);
    const events = windowEvents().filter((entry) => entry.view === second);
    const withdrawn = events.findIndex((entry) => entry.event === "withdrawn");
    assert.ok(withdrawn >= 0);
    assert.ok(
      events.slice(withdrawn + 1).every((entry) => entry.event !== "rx"),
      "The old view received RX after the Host withdrew access",
    );

    await trustAndEnablePlugin();
    if (useWindowsPickers) {
      await setTheme(false);
      await language("zh");
    }
    const restored = await openPlugin(
      useWindowsPickers ? "打开插件" : "Open plugin",
    );
    await expectAcknowledgedRx(restored, beforeClose, whileClosed, afterReopen);
    const attachment = await nativeValue("host_attachment");
    assert.equal(
      attachment.generation,
      generation,
      "Plugin recovery replaced the desktop attachment",
    );
    if (useWindowsPickers) {
      const { handle } = await currentWindowsZoom(restored);
      await driveWindowsView(
        "ZoomCapture",
        handle,
        file("terminal-zh-light.png"),
      );
    }
    writeFileSync(
      file("terminal-catalog-reactivation.json"),
      JSON.stringify({ generation, oldView: second, restoredView: restored }),
      { flag: "wx" },
    );
    await closePlugin(restored);
  });

  it("saves the displayed diagnostics through the owned Windows dialog", async function () {
    if (!useWindowsPickers) return this.skip();
    this.timeout(90000);
    await ready();
    await language("en");
    await expectCommittedLanguage("en");
    await language("zh");
    const { handle } = await currentWindowsZoom("main");
    await verifyNativeDiagnosticsExport(Number(handle));
  });

  it("imports and exports commands through the owned Windows file dialogs", async function () {
    if (!useWindowsPickers) return this.skip();
    this.timeout(90000);
    await ready();
    await language("en");
    await expectCommittedLanguage("en");
    const { handle } = await currentWindowsZoom("main");
    await navigate("/");
    await click($("button[aria-label='Command library']"));

    const input = file("input.swb-commands.jsonl");
    const output = file("output.swb-commands.jsonl");
    const header = {
      kind: "header",
      format: "serial-workbench-command-library",
      version: 1,
      libraryRevision: "17",
    };
    const group = { id: "native-picker-group", name: "Native archive group" };
    const command = {
      summary: {
        id: "native-picker-command",
        groupId: group.id,
        name: "Read register",
        note: "设备地址",
      },
      body: "41 00 FF",
      mode: "hex",
      encoding: "utf-8",
      lineEnding: { kind: "custom", bytesBase64: "AP8=" },
    };
    const end = { kind: "end", groups: "1", commands: "1" };
    const records = [
      { kind: "group", group },
      { kind: "command", command },
      end,
    ];
    writeFileSync(
      input,
      [header, ...records]
        .map((record) => JSON.stringify(record) + "\n")
        .join(""),
      { flag: "wx" },
    );

    const opened = await selectWindowsFile(
      dialogButton("Import commands…"),
      "Open",
      input,
    );
    assert.equal(opened.owner, Number(handle));
    await byText(
      "*[@role='status']",
      "Command library imported",
    ).waitForDisplayed();
    await click(dialogButton(group.name));
    await dialogButton(command.summary.name).waitForDisplayed();

    const saved = await selectWindowsFile(
      dialogButton("Export commands…"),
      "Save",
      output,
      "command-library.swb-commands.jsonl",
    );
    assert.equal(saved.owner, Number(handle));
    await byText(
      "*[@role='status']",
      "Command library exported",
    ).waitForDisplayed();
    const bytes = readFileSync(output);
    const jsonl = bytes.toString("utf8");
    assert.ok(
      jsonl.endsWith("\n"),
      "The archive has no final record delimiter",
    );
    const [exportedHeader, ...exportedRecords] = jsonl
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.match(exportedHeader.libraryRevision, /^[1-9]\d*$/);
    assert.deepEqual(exportedHeader, {
      ...header,
      libraryRevision: exportedHeader.libraryRevision,
    });
    assert.deepEqual(exportedRecords, records);
    writeFileSync(
      file("command-archive-roundtrip.json"),
      JSON.stringify({
        opened,
        saved,
        revision: exportedHeader.libraryRevision,
        groups: exportedRecords.at(-1).groups,
        commands: exportedRecords.at(-1).commands,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
      { flag: "wx" },
    );
  });
});
