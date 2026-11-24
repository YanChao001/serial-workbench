import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { startMcpFixture } from "./mcp-fixture.mjs";
import { checkRuleCommand } from "./paired-rule-evidence.mjs";
import { sessionScopes } from "./session-scopes.mjs";

const [hostPath, cliPath, assetsPath, outputPath, mcpPath] =
  process.argv.slice(2);
assert.ok(
  hostPath && cliPath && assetsPath && outputPath,
  "Usage: node e2e/paired-browser.mjs <Host> <CLI> <workbench assets> <evidence> [MCP]",
);
const hostExecutable = resolve(hostPath);
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const temporary = resolve(tmpdir());
const root = await mkdtemp(join(temporary, "swb-browser-"));
const profile = join(root, "profile");
const cli = async (...args) => {
  const { stdout } = await promisify(execFile)(
    resolve(cliPath),
    ["--profile", profile, ...args, "--json"],
    {
      env: { ...process.env, SWB_DEV_EXPECTED_HOST_EXECUTABLE: hostExecutable },
      windowsHide: true,
      timeout: 15_000,
    },
  );
  const value = JSON.parse(stdout);
  assert.notEqual(value.ok, false, value.error?.code);
  return value;
};

async function readPairingPipe(stdout) {
  let received = Buffer.alloc(0);
  for await (const chunk of stdout) {
    received = Buffer.concat([received, chunk]);
    if (received.length < 4) continue;
    const length = received.readUInt32BE();
    assert.ok(length > 0 && length <= 2048, "invalid pairing handoff length");
    if (received.length >= 4 + length)
      return JSON.parse(received.subarray(4, 4 + length).toString("utf8"));
  }
  throw new Error("Host exited without returning its browser handoff");
}

const hostLog = createWriteStream(join(output, "host.log"), { flags: "wx" });
const host = spawn(
  hostExecutable,
  ["--profile", profile, "--browser-pair-stdio", resolve(assetsPath)],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
host.stderr.pipe(hostLog);
const completed = once(host, "exit");
void completed.catch(() => {});
let browser;
let page;
let result;
const assistants = [];

async function startAssistant(clientId) {
  const assistant = await startMcpFixture({
    binary: resolve(mcpPath),
    profile,
    clientId,
    host: hostExecutable,
  });
  assistants.push(assistant);
  return assistant.call;
}

const frames = [];
const rawBatches = [];
let collectingRawEvidence = false;

async function checkSelectionDownloads(page, first, second) {
  const browserTextMode = /^(Text|文本)$/;
  const title = /^(Byte selection|字节选区)$/;
  const terminal = page.getByRole("region", { name: /^(Receive|接收)$/ });
  const panel = page.getByRole("dialog", { name: title });
  const firstBytes = Buffer.from(first.payload.bytesBase64, "base64");
  const selected = Buffer.concat([
    firstBytes.subarray(firstBytes.length - 2),
    Buffer.from(second.payload.bytesBase64, "base64").subarray(0, 2),
  ]);
  assert.equal(first.payload.byteEnd, second.payload.byteStart);
  assert.equal(selected.toString("utf8"), '<&>"');
  const start = BigInt(first.payload.byteEnd) - 2n;
  const end = start + BigInt(selected.length);
  const initialViewport = page.viewportSize();
  const filters = terminal.getByRole("button", {
    name: /^(Record filters|记录筛选)$/,
  });
  async function chooseDirection(option) {
    await filters.click();
    await page.getByRole("combobox", { name: /^(Direction|方向)$/ }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
    await page.keyboard.press("Escape");
  }
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  await terminal
    .getByRole("button", { name: /^(Search bytes|查找字节)$/ })
    .click();
  await chooseDirection("RX");
  await page.setViewportSize({ width: 420, height: 600 });
  const hex = (event) =>
    terminal.locator(
      `[data-direction="rx"] [data-hex-source][data-hex-byte-start="${event.payload.byteStart}"]`,
    );
  await expect(hex(first)).toBeVisible();
  await expect(hex(second)).toBeVisible();
  await terminal.evaluate(
    (root, { firstStart, secondStart, from }) => {
      const row = (offset) =>
        root.querySelector(
          `[data-direction="rx"] [data-hex-source][data-hex-byte-start="${offset}"]`,
        )?.firstChild;
      const head = row(firstStart);
      const tail = row(secondStart);
      if (!head || !tail)
        throw new Error("Missing original RX selection nodes");
      document.getSelection()?.setBaseAndExtent(head, from, tail, 5);
    },
    {
      firstStart: first.payload.byteStart,
      secondStart: second.payload.byteStart,
      from: (firstBytes.length - 2) * 3,
    },
  );
  await terminal.getByRole("button", { name: title }).click();
  await expect(panel).toContainText("RX · 4 B");

  async function choose(label, option) {
    await panel.getByRole("combobox", { name: label }).click();
    await page.getByRole("option", { name: option }).click();
  }

  async function save({ format, theme, extension, suffix, themeMarkup }) {
    await choose(/^(Selection format|选区格式)$/, format);
    await choose(/^(Export theme|导出主题)$/, theme);
    await expect(panel.locator("pre")).toContainText("3C 26 3E 22");
    const action = panel.getByRole("button", {
      name: /^(Save selection|保存选区)$/,
    });
    await expect(action).toBeInViewport();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      action.click(),
    ]);
    const expectedName = `serial-selection-rx-${start}${suffix}.${extension}`;
    assert.equal(download.suggestedFilename(), expectedName);
    const path = join(output, expectedName);
    await download.saveAs(path);
    const content = await readFile(path, "utf8");
    assert.ok(content.includes(`[${start}, ${end})`));
    assert.ok(content.includes("|&lt;&amp;&gt;&quot;|"));
    assert.ok(content.includes("3C 26 3E 22"));
    assert.ok(content.includes(themeMarkup));
    await expect(panel.getByRole("status")).toContainText(
      /Selection saved|已保存选区/,
    );
    return expectedName;
  }

  const html = await save({
    format: "HTML",
    theme: /^(Dark|深色)$/,
    extension: "html",
    suffix: "",
    themeMarkup: "color-scheme:dark",
  });
  const svg = await save({
    format: "SVG",
    theme: /^(Light|浅色)$/,
    extension: "svg",
    suffix: "-p1",
    themeMarkup: 'fill="#ffffff"',
  });
  await panel.screenshot({
    path: join(output, "receive-selection-download.png"),
  });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  if (initialViewport) await page.setViewportSize(initialViewport);
  await chooseDirection(/^(Both directions|收发双向)$/);
  await terminal
    .getByRole("button", { name: /^(Close search|关闭查找)$/ })
    .click();
  await terminal.getByRole("radio", { name: browserTextMode }).click();
  return {
    firstRxEvent: first.eventSeq,
    lastRxEvent: second.eventSeq,
    start: String(start),
    end: String(end),
    html,
    svg,
  };
}

function recordWire(socket, direction) {
  socket.on(direction, ({ payload }) => {
    if (typeof payload !== "string") return;
    const { channel, requestId, body } = JSON.parse(payload);
    if (
      collectingRawEvidence &&
      direction === "framereceived" &&
      channel === "raw" &&
      body.type === "rawBatch"
    ) {
      // Compare only the isolated Virtual Echo events in memory.
      rawBatches.push(body.batch);
    }
    // Only record message metadata. Exclude credentials, request context and serial payloads.
    frames.push({
      direction,
      channel,
      requestId,
      type: body.type,
      method: body.request?.method,
      action: body.request?.params?.actionId,
      result: body.reply?.result?.kind,
      operation: body.reply?.result?.operation?.state,
      scope: body.delta?.cursor?.scopeId,
      error: body.error?.code ?? body.reply?.error?.code,
    });
  });
}
try {
  const entry = await Promise.race([
    readPairingPipe(host.stdout),
    completed.then(([code]) => {
      throw new Error(`Host exited before pairing (${code})`);
    }),
    setTimeout(15_000, undefined, { ref: false }).then(() => {
      throw new Error("Host browser handoff timed out");
    }),
  ]);
  assert.ok(entry.url.startsWith("http://127.0.0.1:"));
  const context = await cli("context", "--out", join(root, "cli-context.json"));
  const hostTarget = {
    hostId: context.hostId,
    kind: "host",
    id: context.hostId,
  };
  const grants = join(root, "browser-grants.json");
  await writeFile(
    grants,
    JSON.stringify({
      clientId: entry.clientId,
      permissions: [
        "device.modify",
        "content.read",
        "settings.modify",
        "workspace.modify",
      ],
      targets: [hostTarget],
    }),
  );
  const authorized = await cli("authorize", "--params-json", grants);
  assert.equal(authorized.result.operation.actionId, "auth.authorize");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1240, height: 800 } });
  page.on("websocket", (socket) => {
    recordWire(socket, "framesent");
    recordWire(socket, "framereceived");
  });
  await page.goto(entry.url);
  const code = page.getByLabel(/配对码|Pairing code/);
  const connect = page.getByRole("button", { name: /^(连接|Connect)$/ });
  await code.fill("A".repeat(43));
  await connect.click();
  await expect(page.getByRole("alert")).toContainText(/无效|invalid/);
  await code.fill(entry.pairingCode);
  await connect.click();
  await expect(code).toHaveCount(0);
  const unpaired = await browser.newPage();
  try {
    await unpaired.goto(entry.url);
    await unpaired.getByLabel(/配对码|Pairing code/).fill(entry.pairingCode);
    await unpaired.getByRole("button", { name: /^(连接|Connect)$/ }).click();
    await expect(unpaired.getByRole("alert")).toContainText(/无效|invalid/);
  } finally {
    await unpaired.close();
  }
  const device = page.locator(".workbench-device-select");
  await device.click();
  await page.getByRole("option", { name: "virtual:echo", exact: true }).click();
  const openMonitor = page.getByRole("button", {
    name: /^(打开|Open) virtual:echo$/,
  });
  await openMonitor.click();
  const closed = page.getByRole("button", { name: /关闭会话|Close session/ });
  await expect(closed).toBeEnabled();

  const paramsPath = join(root, "empty.json");
  const hostTargetPath = join(root, "host.json");
  const workspacePath = join(root, "workspace.json");
  await writeFile(paramsPath, "{}");
  await writeFile(hostTargetPath, JSON.stringify(hostTarget));
  await writeFile(
    workspacePath,
    JSON.stringify({
      hostId: context.hostId,
      kind: "workspace",
      id: "default",
    }),
  );
  const query = (action, target, params = paramsPath) =>
    cli("query", action, "--target-json", target, "--params-json", params);
  async function liveSession() {
    const scopes = await query("state.scopes", hostTargetPath);
    const sessions = sessionScopes(scopes.result.value.scopes);
    assert.equal(
      sessions.length,
      1,
      "CLI and browser must share one live session",
    );
    return sessions[0].target;
  }

  collectingRawEvidence = true;
  async function echo(text) {
    const start = rawBatches.length;
    await page.getByRole("textbox", { name: /发送草稿|Send draft/ }).fill(text);
    await page.getByRole("button", { name: /^(发送|Send)$/ }).click();
    const rx = page.locator('.workbench-stream-row[data-direction="rx"]');
    await expect(rx.filter({ hasText: text })).toHaveCount(1);
    const bytes = Buffer.from(text).toString("base64");
    const matching = () =>
      rawBatches
        .slice(start)
        .flatMap(({ items, cursor, previousCursor }) =>
          items
            .filter(
              ({ kind, event }) =>
                kind === "source" &&
                (event.kind === "tx" || event.kind === "rx") &&
                event.payload.bytesBase64 === bytes,
            )
            .map(({ event }) => ({ event, cursor, previousCursor })),
        );
    await expect.poll(() => matching().length).toBe(2);
    const events = matching();
    assert.equal(events.filter(({ event }) => event.kind === "tx").length, 1);
    assert.equal(events.filter(({ event }) => event.kind === "rx").length, 1);
    return events;
  }
  const beforeReload = await echo("paired browser before reload");
  const original = await liveSession();
  await page
    .getByRole("button", { name: /保存当前布局|Save current layout/ })
    .click();
  await expect
    .poll(async () => {
      const workspace = await query("workspace.read", workspacePath);
      return workspace.result.value.document.value.bindings.some(
        ({ deviceId }) => deviceId === "virtual:echo",
      );
    })
    .toBe(true);
  await page.reload();
  await expect(code).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "virtual:echo" })).toBeVisible();
  // The saved layout restores the view. The user explicitly attaches it to the live port.
  await openMonitor.click();
  await expect(closed).toBeEnabled();
  const afterReload = await echo("paired browser after reload");
  collectingRawEvidence = false;
  rawBatches.length = 0;
  await page.screenshot({ path: join(output, "workbench.png") });
  assert.equal(
    frames.filter(({ action }) => action === "session.tx").length,
    2,
  );

  assert.deepEqual(
    await liveSession(),
    original,
    "reload changed the Host session or its epoch",
  );
  const rawTargetPath = join(root, "raw-target.json");
  const rawGrantPath = join(root, "raw-grant.json");
  await writeFile(rawTargetPath, JSON.stringify(original), { flag: "wx" });
  await writeFile(
    rawGrantPath,
    JSON.stringify({
      clientId: context.clientId,
      permissions: ["content.read"],
      targets: [original],
    }),
    { flag: "wx" },
  );
  await cli("authorize", "--params-json", rawGrantPath);
  const readParams = async (name, startEventSeq, maxEvents) => {
    const path = join(root, name + ".json");
    await writeFile(
      path,
      JSON.stringify({
        sessionId: original.id,
        sessionEpoch: original.sessionEpoch,
        startEventSeq,
        maxEvents,
        maxBytes: "262144",
      }),
      { flag: "wx" },
    );
    return path;
  };
  const browserEvents = [...beforeReload, ...afterReload];
  for (const { event, cursor, previousCursor } of browserEvents) {
    assert.equal(event.hostId, original.hostId);
    assert.equal(event.instanceEpoch, context.instanceEpoch);
    assert.equal(event.sessionId, original.id);
    assert.equal(event.sessionEpoch, original.sessionEpoch);
    assert.equal(cursor.hostId, event.hostId);
    assert.equal(cursor.instanceEpoch, event.instanceEpoch);
    assert.deepEqual({ ...previousCursor, position: cursor.position }, cursor);
    assert.ok(BigInt(previousCursor.position) < BigInt(event.eventSeq));
    assert.ok(BigInt(event.eventSeq) <= BigInt(cursor.position));
  }
  const firstParams = await readParams(
    "raw-first",
    browserEvents[0].event.eventSeq,
    "1",
  );
  let firstPage;
  await expect
    .poll(async () => {
      try {
        firstPage = (await query("stream.read", rawTargetPath, firstParams))
          .result.value;
        return true;
      } catch (error) {
        if (
          error.code === 3 &&
          JSON.parse(error.stdout).error?.code === "PERMISSION_DENIED"
        )
          return false;
        throw error;
      }
    })
    .toBe(true);
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.hasMore, true);
  const continuation = await readParams(
    "raw-continuation",
    firstPage.nextEventSeq,
    "100",
  );
  const nextPage = (await query("stream.read", rawTargetPath, continuation))
    .result.value;
  const localEvents = [...firstPage.events, ...nextPage.events];
  for (const { event } of browserEvents) {
    const local = localEvents.find(
      ({ eventSeq }) => eventSeq === event.eventSeq,
    );
    assert.deepEqual(local, event, "WebSocket and IPC Raw events differ");
  }

  collectingRawEvidence = true;
  const downloadSamples = [await echo("EXPORT<&"), await echo('>"EXPORT')].map(
    (events) => events.find(({ event }) => event.kind === "rx").event,
  );
  collectingRawEvidence = false;
  rawBatches.length = 0;
  const exportRead = await readParams(
    "raw-export",
    downloadSamples[0].eventSeq,
    "100",
  );
  const exportEvents = (await query("stream.read", rawTargetPath, exportRead))
    .result.value.events;
  const [firstExport, secondExport] = downloadSamples.map((event) => {
    const actual = exportEvents.find(
      ({ eventSeq }) => eventSeq === event.eventSeq,
    );
    assert.deepEqual(actual, event);
    return actual;
  });
  const selectionDownloads = await checkSelectionDownloads(
    page,
    firstExport,
    secondExport,
  );
  const ruleCommand = await checkRuleCommand({
    page,
    session: original,
    async readWorkspace() {
      return (await query("workspace.read", workspacePath)).result.value
        .document;
    },
    async readRaw(label, start = "1") {
      const params = await readParams(label, start, "100");
      const { result } = await query("stream.read", rawTargetPath, params);
      assert.equal(result.value.hasMore, false);
      return result.value;
    },
    async getOperation(id) {
      const { result } = await cli("operation", "get", id);
      return result.operation;
    },
    async readResult(label, fileRef) {
      const fileTarget = join(root, label + "-target.json");
      const params = join(root, label + "-params.json");
      await writeFile(
        fileTarget,
        JSON.stringify({
          hostId: fileRef.hostId,
          kind: fileRef.kind,
          id: fileRef.id,
        }),
      );
      await writeFile(
        params,
        JSON.stringify({ fileRef, offset: "0", maxBytes: "65536" }),
      );
      const { result } = await query("file.read", fileTarget, params);
      assert.equal(result.value.atEnd, true);
      return JSON.parse(
        Buffer.from(result.value.bytesBase64, "base64").toString("utf8"),
      );
    },
  });
  const settingsPath = join(root, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ hostId: context.hostId, kind: "settings", id: "shared" }),
  );
  await page.getByRole("link", { name: /^(设置|Settings)$/ }).click();
  await page.getByRole("combobox", { name: /^(语言|Language)$/ }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect
    .poll(async () => {
      const settings = await query("settings.read", settingsPath);
      return settings.result.value.document.value.language;
    })
    .toBe("en");
  let followedNamedMcp = false;
  if (mcpPath) {
    const first = await startAssistant("bench-primary");
    const other = await startAssistant("bench-secondary");
    const firstRead = { requestId: randomUUID() };
    const sessionQuery = "swb_session_x2E_get";
    await first(sessionQuery, original, {}, firstRead);
    await other(sessionQuery, original);
    const workbench = page.getByRole("link", {
      name: "Serial Workbench",
      exact: true,
    });
    const settings = page.getByRole("link", { name: "Settings", exact: true });
    const activity = page.getByRole("button", {
      name: "Activity",
      exact: true,
    });
    const settingsRoute = /#\/settings/;
    const workbenchRoute = /#\/$/;
    await workbench.click();
    const draft = page.getByRole("textbox", { name: "Send draft" });
    await draft.fill("manual draft stays in this window");
    await activity.click();
    await page.getByRole("combobox", { name: "AI client to follow" }).click();
    await page.getByRole("option", { name: "bench-primary" }).click();
    await expect(page.getByRole("listbox")).toBeHidden();
    await page.screenshot({ path: join(output, "mcp-activity.png") });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close view" })
      .click();

    const popupEvent = page.waitForEvent("popup");
    await page.evaluate(() => {
      window.open(location.href, "second-workbench");
    });
    const otherWindow = await popupEvent;
    await otherWindow
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await settings.click();
    await expect(page).toHaveURL(settingsRoute);
    await expect(otherWindow).toHaveURL(settingsRoute);
    const activityDeltas = () =>
      frames.filter(({ scope }) => scope === "host.activity").length;
    const previousActivity = activityDeltas();
    await first(sessionQuery, original, {}, firstRead);
    await other(sessionQuery, original);
    await expect
      .poll(activityDeltas)
      .toBeGreaterThanOrEqual(previousActivity + 2);
    await expect(page).toHaveURL(settingsRoute);
    await first(sessionQuery, original);
    await expect(page).toHaveURL(workbenchRoute);
    await expect(otherWindow).toHaveURL(settingsRoute);
    await expect(draft).toHaveValue("manual draft stays in this window");

    const deviceListCall = { requestId: randomUUID() };
    const deviceListTool = "swb_device_x2E_list";
    const devicesPanel = page.getByRole("dialog", {
      name: "Devices",
      exact: true,
    });
    const workspacePanel = page.getByRole("dialog", {
      name: "Workspace",
      exact: true,
    });
    await draft.focus();
    const beforeDeviceList = activityDeltas();
    await first(deviceListTool, hostTarget, {}, deviceListCall);
    await first("swb_workspace_x2E_list", hostTarget);
    await expect
      .poll(activityDeltas)
      .toBeGreaterThanOrEqual(beforeDeviceList + 2);
    await expect(draft).toBeFocused();
    await expect(devicesPanel).toBeHidden();
    await expect(workspacePanel).toBeHidden();
    await draft.press("Tab");
    await expect(devicesPanel).toBeVisible();
    await expect(otherWindow).toHaveURL(settingsRoute);
    await page.screenshot({
      path: join(output, "mcp-device-library-reveal.png"),
    });
    await devicesPanel.getByRole("button", { name: "Close view" }).click();
    await expect(workspacePanel).toBeVisible();
    await workspacePanel.getByRole("button", { name: "Close view" }).click();
    const beforeDeviceListPoll = activityDeltas();
    await first(deviceListTool, hostTarget, {}, deviceListCall);
    await expect.poll(activityDeltas).toBeGreaterThan(beforeDeviceListPoll);
    await expect(devicesPanel).toBeHidden();
    await expect(draft).toHaveValue("manual draft stays in this window");

    await activity.click();
    await page.getByRole("button", { name: "Pause following" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close view" })
      .click();
    await settings.click();
    await writeFile(
      grants,
      JSON.stringify({
        clientId: "bench-primary",
        permissions: ["device.modify"],
        targets: [original],
      }),
    );
    await cli("authorize", "--params-json", grants);
    const sent = "MCP sent while navigation was paused";
    const serial = {
      bytesBase64: Buffer.from(sent).toString("base64"),
      writeWaitMs: "1000",
    };
    await expect
      .poll(async () => {
        try {
          const access = await first("swb_action_x2E_check", original, {
            actionId: "session.tx",
            params: serial,
          });
          return access.allowed;
        } catch (error) {
          // A read racing the grant commit can be rejected by its old stamp.
          if (error.code === "PERMISSION_DENIED") return false;
          throw error;
        }
      })
      .toBe(true);
    const accepted = await first("swb_session_x2E_tx", original, serial);
    assert.equal(accepted.actionId, "session.tx");
    await expect(page).toHaveURL(settingsRoute);
    await workbench.click();
    await expect(
      page
        .locator('.workbench-stream-row[data-direction="rx"]')
        .filter({ hasText: sent }),
    ).toBeVisible();
    await expect(draft).toHaveValue("manual draft stays in this window");

    const activityParams = join(root, "activity-params.json");
    await writeFile(
      activityParams,
      JSON.stringify({ scopeId: "host.activity" }),
    );
    const pendingTakeover = async () => {
      const snapshot = await query(
        "state.snapshot",
        hostTargetPath,
        activityParams,
      );
      return snapshot.result.value.state.pendingTakeover;
    };
    await activity.click();
    await page
      .getByRole("button", { name: "Request control of virtual:echo" })
      .click();
    await expect(
      page.getByText(
        "Waiting for desktop confirmation and serial writes to settle…",
      ),
    ).toBeVisible();
    await expect.poll(pendingTakeover).toMatchObject({
      clientId: "bench-primary",
      deviceId: "virtual:echo",
      target: original,
    });
    await page.screenshot({
      path: join(output, "browser-takeover-requested.png"),
    });
    await page.close();
    page = otherWindow;
    await expect.poll(pendingTakeover).toBeUndefined();
    const stillAllowed = await first("swb_action_x2E_check", original, {
      actionId: "session.tx",
      params: serial,
    });
    assert.equal(stillAllowed.allowed, true);
    followedNamedMcp = true;
  }
  result = {
    rejectedInvalidTicket: true,
    consumedTicketRejectedInAnotherBrowser: true,
    browserAttachedToCliHost: true,
    cliObservedWorkspaceSavedByBrowser: true,
    cliObservedSettingsSavedByBrowser: true,
    virtualEchoRxBeforeAndAfterReload: true,
    sessionEpochPreserved: true,
    selectionDownloads,
    ruleCommand,
    rawParity: {
      hostId: original.hostId,
      instanceEpoch: context.instanceEpoch,
      sessionId: original.id,
      sessionEpoch: original.sessionEpoch,
      events: browserEvents.map(({ event, cursor }) => ({
        kind: event.kind,
        eventSeq: event.eventSeq,
        cursor: cursor.position,
        bytes: Buffer.from(event.payload.bytesBase64, "base64").length,
      })),
      nextEventSeq: firstPage.nextEventSeq,
    },
    ...(mcpPath && followedNamedMcp
      ? {
          mcpFollow: {
            selected: "bench-primary",
            secondClient: "bench-secondary",
            target: original,
            boundWindowOnly: true,
            repeatedQueryDidNotNavigate: true,
            otherClientDidNotNavigate: true,
            manualDraftPreserved: true,
            selectedWindowOpenedDeclaredToolAfterEditing: true,
            pendingActivitiesRevealedInStartOrder: true,
            repeatedQueryDidNotReopenTool: true,
            pausedMcpStillEchoed: true,
            browserRequestedControlOfSelectedPort: true,
            requesterDisconnectClearedPendingWithoutRevokingMcp: true,
          },
        }
      : {}),
  };
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: join(output, "failure.png") });
  await writeFile(
    join(output, "wire-metadata.json"),
    JSON.stringify(frames, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  for (const assistant of assistants) await assistant.stop();
  let stopped = host.exitCode !== null;
  if (!stopped) {
    try {
      const receipt = await cli("host", "stop");
      stopped = receipt.stopped === true;
    } catch (error) {
      process.stderr.write(
        `Could not stop the fixture Host through IPC: ${error.message}\n`,
      );
    } finally {
      if (!stopped) host.kill();
    }
  }
  const [code] = await completed;
  assert.equal(dirname(root), temporary);
  await rm(root, { recursive: true });
  if (result) {
    assert.equal(stopped && code === 0, true, "Host did not exit cleanly");
    await writeFile(
      join(output, "receipt.json"),
      JSON.stringify({ ...result, hostExit: code }, null, 2) + "\n",
    );
    process.stdout.write(
      mcpPath
        ? "Paired browser followed the selected MCP client, paused navigation, and retired the takeover request on disconnect.\n"
        : "Paired browser used the live Host, echoed serial data and recovered after reload.\n",
    );
  }
}
