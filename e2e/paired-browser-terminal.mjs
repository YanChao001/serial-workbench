import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const [outputPath] = process.argv.slice(2);
assert.ok(
  outputPath,
  "Usage: paired-browser-terminal.mjs <evidence directory>",
);
const output = resolve(outputPath);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const commands = input[Symbol.asyncIterator]();
const next = async () => {
  const line = await commands.next();
  assert.ok(!line.done, "Host fixture closed its private input");
  return line.value;
};
const fixture = JSON.parse(await next());
assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
const expectCommand = async (expected) => {
  assert.equal(await next(), expected, "Host fixture stage did not finish");
};
const wait = { timeout: 30_000 };
const subscriptions = new Map();
const batches = new Map();
const rawOwners = new Map();
const workbenchReads = [];
let socketNumber = 0;
const terminal = {
  archiveSha256: fixture.archiveSha256,
  target: fixture.target,
  instanceEpoch: fixture.instanceEpoch,
  stages: [],
  subscriptions: [],
  cleanups: [],
  phase: "launch-chromium",
  diagnostics: {
    browser: [],
    frameStatuses: [],
    assetRequests: 0,
    assetReplies: 0,
    rawBatches: 0,
    rpcErrors: {},
  },
};
const receivedArchives = new Set();
const framePath = "/browser-plugin-frame";
let browser;
let page;

function sanitized(message) {
  return message
    .replaceAll(fixture.pairingCode, "[redacted]")
    .replace(/(?<![\w-])[A-Za-z0-9_-]{43}(?![\w-])/g, "[redacted]");
}

function rememberBrowserError(kind, message) {
  const messages = terminal.diagnostics.browser;
  if (messages.length === 16) messages.shift();
  messages.push({ kind, message: sanitized(message).slice(0, 400) });
}

function sameSource(source) {
  return (
    source.hostId === fixture.target.hostId &&
    source.instanceEpoch === fixture.instanceEpoch &&
    source.sessionId === fixture.target.sessionId &&
    source.sessionEpoch === fixture.target.sessionEpoch
  );
}

function capabilityKey(token) {
  // Correlate connections without keeping or publishing the wire credentials.
  return createHash("sha256").update(token).digest("hex");
}

function observeWire(socket) {
  const observed = { id: ++socketNumber, control: undefined, closed: false };
  const assets = new Set();
  const details = new Set();
  const subscribing = new Set();
  const closing = new Map();
  const ended = new Set();
  const closeAcks = new Set();
  observed.ended = ended;
  observed.closeAcks = closeAcks;
  socket.on("close", () => {
    observed.closed = true;
  });
  socket.on("framesent", ({ payload }) => {
    if (typeof payload !== "string") return;
    const { requestId, channel, body } = JSON.parse(payload);
    if (channel === "raw" && body.type === "rawAttach") {
      const key = capabilityKey(body.token);
      observed.control = rawOwners.get(key);
      rawOwners.delete(key);
    }
    const request = body.request;
    if (!request) return;
    if (request.params?.actionId === "node.views.assetRead") {
      assets.add(requestId);
      terminal.diagnostics.assetRequests++;
    } else if (
      channel === "control" &&
      request.params?.actionId === "node.packages.detailsRead"
    ) {
      details.add(requestId);
    } else if (channel === "raw" && request.method === "stream.subscribe") {
      subscribing.add(requestId);
    } else if (channel === "raw" && request.method === "subscription.close") {
      closing.set(requestId, request.params.params.subscriptionId);
    }
  });
  socket.on("framereceived", ({ payload }) => {
    if (typeof payload !== "string") return;
    const { requestId, channel, body } = JSON.parse(payload);
    const code = body.reply?.error?.code ?? body.error?.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      const errors = terminal.diagnostics.rpcErrors;
      errors[code] = (errors[code] ?? 0) + 1;
    }
    if (channel === "control" && body.type === "authenticated") {
      rawOwners.set(capabilityKey(body.rawAttachToken), observed.id);
    }
    if (details.delete(requestId) && body.reply?.ok) {
      workbenchReads.push(observed);
    }
    if (assets.delete(requestId) && body.reply?.ok) {
      const result = body.reply.result;
      if (result.kind === "node_view_asset") {
        terminal.diagnostics.assetReplies++;
        receivedArchives.add(result.value.archiveSha256);
      }
    }
    if (channel !== "raw") return;
    if (subscribing.delete(requestId) && body.reply?.ok) {
      const result = body.reply.result;
      const subscriptionId =
        result.subscriptionId ??
        (result.kind === "subscription" || result.kind === "stream_subscribe"
          ? result.value.subscriptionId
          : undefined);
      if (subscriptionId) subscriptions.set(subscriptionId, observed);
    }
    const closingId = closing.get(requestId);
    if (closingId && body.reply) {
      closing.delete(requestId);
      if (body.reply.ok) closeAcks.add(closingId);
    }
    if (body.type === "subscriptionEnded") ended.add(body.subscriptionId);
    if (body.type !== "rawBatch") return;
    terminal.diagnostics.rawBatches++;
    const { subscriptionId, items } = body.batch;
    for (const item of items) {
      if (item.kind !== "source" || item.event.kind !== "rx") continue;
      const { event } = item;
      if (!sameSource(event)) continue;
      const existing = batches.get(subscriptionId);
      if (existing && existing.socket !== observed) continue;
      const previous = existing?.bytes ?? Buffer.alloc(0);
      const rx = Buffer.concat([
        previous,
        Buffer.from(event.payload.bytesBase64, "base64"),
      ]);
      // Only the fixture's short markers are needed to match a reader.
      batches.set(subscriptionId, {
        socket: observed,
        bytes: rx.subarray(Math.max(0, rx.length - 4096)),
      });
    }
  });
}

function readerFor(marker, existing, workbench) {
  const found = [...batches].find(([id, { bytes, socket }]) => {
    return (
      !existing.has(id) &&
      subscriptions.get(id) === socket &&
      socket.control !== undefined &&
      socket.control !== workbench.id &&
      bytes.includes(marker)
    );
  });
  return found ? { id: found[0], socket: found[1].socket } : undefined;
}

function cleanupKind({ id, socket }) {
  if (socket.closeAcks.has(id)) return "subscription-close-ack";
  if (socket.ended.has(id)) return "subscription-ended";
  if (socket.closed) return "raw-socket-closed";
}

async function verifyCleanup(reader) {
  await expect.poll(() => Boolean(cleanupKind(reader)), wait).toBe(true);
  terminal.cleanups.push({
    subscriptionId: reader.id,
    rawSocket: reader.socket.id,
    controlSocket: reader.socket.control,
    kind: cleanupKind(reader),
  });
}

function announce(stage) {
  terminal.stages.push(stage);
  process.stdout.write(stage + "\n");
}

try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1200, height: 800 },
  });
  page.on("websocket", observeWire);
  page.on("console", (message) => {
    const kind = message.type();
    if (kind === "error" || kind === "warning")
      rememberBrowserError(kind, message.text());
  });
  page.on("pageerror", (error) =>
    rememberBrowserError("pageerror", error.message),
  );
  const policies = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === framePath) {
      policies.push(response.headers()["content-security-policy"]);
      terminal.diagnostics.frameStatuses.push(response.status());
    }
  });

  terminal.phase = "load-workbench";
  const workbench = await page.goto(fixture.url);
  assert.ok(workbench?.ok(), "The real Host did not serve the browser app");
  assert.match(
    workbench.headers()["content-security-policy"],
    /frame-src[^;]+\/browser-plugin-frame/,
  );
  terminal.phase = "pair";
  const pairingCode = page.getByLabel(/^(Pairing code|配对码)$/);
  await pairingCode.fill(fixture.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(pairingCode).toHaveCount(0, wait);
  terminal.phase = "open-plugin-catalog";
  await page.getByRole("link", { name: /^(Plugins|插件)$/ }).click();
  await expect(page).toHaveURL(/#\/plugins$/, wait);
  await expect(
    page.getByRole("button", { name: /^(Install plugin|安装插件)$/ }),
  ).toHaveCount(0, wait);
  const installedPackage = page.getByRole("button", { name: /Serial Monitor/ });
  await installedPackage.click();

  const open = page.getByRole("button", { name: /^(Open plugin|打开插件)$/ });
  const dialog = page.getByRole("dialog", {
    name: "Serial Monitor",
    exact: true,
  });
  const iframe = dialog.locator('iframe[title="Serial Monitor"]');
  const text = dialog
    .frameLocator("iframe")
    .getByLabel(/^(Serial data|串口数据)$/);
  const checkDisplay = async (marker) => {
    await expect(text).toBeVisible(wait);
    await expect
      .poll(async () => {
        // TX also displays the payload, with a prefix. Match a complete RX line.
        return (await text.textContent()).split("\n").includes(marker.trim());
      }, wait)
      .toBe(true);
  };

  await expect(open).toBeEnabled(wait);
  const workbenchSocket = workbenchReads.at(-1);
  assert.ok(
    workbenchSocket && !workbenchSocket.closed,
    "Missing original workbench Control read",
  );
  terminal.phase = "open-first-view";
  const earlier = new Set(subscriptions.keys());
  await open.click();
  await expect(dialog).toBeVisible(wait);
  await checkDisplay(fixture.first);
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const isolation = await text.evaluate(() => {
    let parentDocument = false;
    try {
      parentDocument = Boolean(window.parent.document);
    } catch {
      // An opaque origin must not see the parent document.
    }
    return {
      origin: window.origin,
      parentDocument,
      tauri: typeof window.__TAURI_INTERNALS__,
      node: typeof window.require,
      process: typeof window.process,
    };
  });
  assert.deepEqual(isolation, {
    origin: "null",
    parentDocument: false,
    tauri: "undefined",
    node: "undefined",
    process: "undefined",
  });
  terminal.isolation = isolation;
  assert.ok(policies.length > 0);
  for (const policy of policies) {
    assert.match(policy, /sandbox allow-scripts(?:;|$)/);
    assert.match(policy, /default-src 'none'(?:;|$)/);
    assert.match(policy, /connect-src 'none'(?:;|$)/);
  }
  assert.deepEqual([...receivedArchives], [fixture.archiveSha256]);

  const firstReader = readerFor(fixture.first, earlier, workbenchSocket);
  assert.ok(
    firstReader,
    "No dedicated scoped Raw reader delivered the first RX",
  );
  terminal.subscriptions.push(firstReader.id);
  terminal.phase = "close-first-view";
  await dialog.getByRole("button", { name: /^(Close|关闭)$/ }).click();
  await expect(dialog).toHaveCount(0, wait);
  await expect(open).toBeFocused(wait);
  await verifyCleanup(firstReader);
  terminal.phase = "read-workbench-after-close";
  const workbenchReadCount = workbenchReads.length;
  await installedPackage.click();
  await expect(open).toHaveCount(0, wait);
  await installedPackage.click();
  await expect(open).toBeEnabled(wait);
  await expect
    .poll(() => {
      return (
        !workbenchSocket.closed &&
        workbenchReads.slice(workbenchReadCount).includes(workbenchSocket)
      );
    }, wait)
    .toBe(true);
  terminal.workbenchAfterClose = {
    actionId: "node.packages.detailsRead",
    controlSocket: workbenchSocket.id,
  };
  announce("VIEW_CLOSED");
  await expectCommand("SECOND_MARKER_WRITTEN");

  terminal.phase = "reopen-view";
  const beforeReopen = new Set(subscriptions.keys());
  await open.click();
  await checkDisplay(fixture.first);
  await checkDisplay(fixture.second);
  const secondReader = readerFor(fixture.second, beforeReopen, workbenchSocket);
  assert.ok(secondReader, "Reopen did not use a fresh scoped Raw reader");
  assert.notEqual(secondReader.socket.id, firstReader.socket.id);
  assert.notEqual(secondReader.socket.control, firstReader.socket.control);
  terminal.subscriptions.push(secondReader.id);
  announce("VIEW_REOPENED");
  terminal.phase = "observe-execution-trust-revoke";
  await expectCommand("EXECUTION_TRUST_REVOKED");
  await expect(iframe).toHaveCount(0, wait);
  await verifyCleanup(secondReader);
  announce("VIEW_RETIRED");
  terminal.phase = "done";
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  terminal.error = sanitized(detail);
  if (page && !page.isClosed()) {
    const content = await page
      .locator("main")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    terminal.diagnostics.route = new URL(page.url()).hash;
    terminal.diagnostics.content = sanitized(content).slice(0, 900);
  }
  process.stderr.write(
    "[paired-browser-terminal] " +
      terminal.phase +
      "\n" +
      terminal.error +
      "\n",
  );
  process.exitCode = 1;
} finally {
  input.close();
  process.stdin.pause();
  await browser?.close();
  await writeFile(
    join(output, "browser-terminal-receipt.json"),
    JSON.stringify(
      { ...terminal, archiveReceipts: [...receivedArchives] },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
