import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { language, navigate, ready } from "../helpers.mjs";
import { hostQuery, nativeValue } from "../settings.mjs";
import { openVirtual } from "./workbench.mjs";

const execute = promisify(execFile);
const directory = process.env.STARTER_E2E_TERMINAL_DIR;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const file = (name) => join(directory, name);

function byText(tag, text, within = "") {
  return $(`${within}//${tag}[normalize-space()=${JSON.stringify(text)}]`);
}

async function click(element) {
  await element.waitForDisplayed();
  await element.waitForEnabled();
  await element.click();
}

const button = (text) => byText("button", text);
const option = (text) => byText("*[@role='option']", text);
const dialogButton = (text) => byText("button", text, "//*[@role='dialog']");
const field = (suffix) => $(`main input[id$='-${suffix}']`);

async function selectFile(element, action, path) {
  if (process.env.SWB_E2E_WINDOWS_NATIVE_PICKERS !== "1") {
    await click(element);
    return;
  }
  const pid = Number(process.env.STARTER_E2E_APP_PID);
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0,
    "Missing owned application PID",
  );
  const script = fileURLToPath(
    new URL("../windows-terminal-picker.ps1", import.meta.url),
  );
  const [{ stdout }] = await Promise.all([
    execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-MTA",
        "-File",
        script,
        "-ApplicationPid",
        String(pid),
        "-Action",
        action,
        "-FilePath",
        path,
      ],
      { timeout: 30000, windowsHide: true },
    ).catch((error) => {
      throw new Error(
        `Native ${action} picker failed (exit=${error.code}, signal=${error.signal}, killed=${error.killed}): ${error.message}`,
        { cause: error },
      );
    }),
    click(element),
  ]);
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.action, action);
  assert.equal(evidence.applicationPid, pid);
  assert.equal(evidence.path, path);
  assert.equal(evidence.returnedFocus, true);
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

async function showTerminalDetails() {
  await navigate("/plugins");
  const row = $(
    "//button[@aria-expanded and .//*[normalize-space()='Serial Workbench Terminal']]",
  );
  await row.waitForDisplayed();
  if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
}

async function install(fixture) {
  await navigate("/plugins");
  await click(button("Manage sources"));
  await field("source").setValue(fixture.source);
  await field("key").setValue(fixture.keyId);
  await field("public").setValue(fixture.publicKeyHex);
  await click(button("Add source"));
  await click(dialogButton("Trust this source"));
  await byText("*", fixture.source).waitForDisplayed();
  await click(button("Install plugin"));
  await click($("[role='dialog'] [role='combobox']"));
  await click(option(fixture.source));
  await selectFile(dialogButton("Choose plugin file"), "Open", fixture.archive);
  await byText(
    "*",
    `Signature verified · ${fixture.source}`,
  ).waitForDisplayed();
  await click(button("Trust this plugin"));
  await byText(
    "*",
    "Read serial data",
    "//*[@role='dialog']",
  ).waitForDisplayed();
  await click(dialogButton("Trust this plugin"));
  await click(button("Enable"));
  await button("Open plugin").waitForEnabled();
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

async function waitEvent(predicate, timeoutMsg) {
  let match;
  await browser.waitUntil(
    () => Boolean((match = windowEvents().find(predicate))),
    { timeoutMsg },
  );
  return match;
}

async function openPlugin(except) {
  await showTerminalDetails();
  await click(button("Open plugin"));
  const { view } = await waitEvent(
    (entry) => entry.event === "shown" && entry.view !== except,
    "The native plugin window was not shown",
  );
  await button("Open plugin").waitForEnabled();
  return view;
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
      if (received < expected.length) return false;
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
  await navigate("/");
  const hexMode = byText(
    "*[@role='radio']",
    "HEX",
    "//*[@data-panel-id='send']",
  );
  await hexMode.waitForDisplayed();
  if ((await hexMode.getAttribute("aria-checked")) === "false")
    await hexMode.click();
  const draft = $(".workbench-draft");
  await draft.waitForDisplayed();
  await draft.setValue(hex.match(/../g).join(" "));
  await click($("button[aria-label='Send']"));
  const marker = Buffer.from(hex, "hex").toString("utf8").trim();
  await browser.waitUntil(() =>
    browser.execute(
      (expected) =>
        document
          .querySelector(".workbench-receive-frame")
          ?.innerText.includes(expected),
      marker,
    ),
  );
  assert.equal(await captureButton().getAttribute("aria-pressed"), "true");
}

describe("Signed terminal on the real desktop", () => {
  it("installs, records across view close and reopen, and stops delivery on revocation", async function () {
    this.timeout(180000);
    const fixture = readJson(file("terminal-inputs.json"));
    const { beforeClose, whileClosed, afterReopen } = fixture.writes;
    await ready();
    await language("en");
    await navigate("/");
    await openVirtual();
    await install(fixture);
    await navigate("/");
    await startCapture(fixture.capture);
    const baseline = await readerBytes();

    const first = await openPlugin();
    await send(beforeClose);
    await expectAcknowledgedRx(first, beforeClose);
    const open = await readerBytes();
    assert.ok(open > baseline, "The native view must own a separate reader");
    await nativeValue("host_close_node_view", { id: first });
    await waitEvent(
      (entry) => entry.view === first && entry.event === "closed",
      "The first native Wry window was not destroyed",
    );
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
    const second = await openPlugin(first);
    await expectAcknowledgedRx(second, beforeClose, whileClosed);
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
    await nativeValue("host_close_node_view", { id: second });
    await waitEvent(
      (entry) => entry.view === second && entry.event === "closed",
      "The reopened native window was not destroyed",
    );
    const events = windowEvents().filter((entry) => entry.view === second);
    const withdrawn = events.findIndex((entry) => entry.event === "withdrawn");
    assert.ok(withdrawn >= 0);
    assert.ok(
      events.slice(withdrawn + 1).every((entry) => entry.event !== "rx"),
      "The old view received RX after the Host withdrew access",
    );
  });
});
