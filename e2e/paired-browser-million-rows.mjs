import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const [output] = process.argv.slice(2);
assert.ok(output, "Benchmark evidence directory is required");
const run = promisify(execFile);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const messages = input[Symbol.asyncIterator]();
const reply = (stage, fields = {}) =>
  process.stdout.write(JSON.stringify({ stage, ...fields }) + "\n");
const lineText = (line) => `SWB${String(line).padStart(7, "0")}`;

async function receive(kind) {
  const next = await messages.next();
  assert.ok(!next.done, `Host exited before ${kind}`);
  const message = JSON.parse(next.value);
  if (kind) assert.equal(message.kind, kind);
  return message;
}

async function processMemory(cdp, start) {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const ids = [...new Set(processInfo.map(({ id }) => id))];
  assert.ok(
    ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0),
  );
  const args =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`,
          ],
        ]
      : ["ps", ["-o", "pid=,rss=", "-p", ids.join(",")]];
  const { stdout } = await run(...args, { windowsHide: true, timeout: 10_000 });
  const scale = process.platform === "win32" ? 1 : 1024;
  const processes = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      const [pid, rss] = row.trim().split(/\s+/).map(Number);
      assert.ok(ids.includes(pid) && Number.isSafeInteger(rss) && rss > 0);
      return { pid, rssBytes: rss * scale };
    });
  assert.ok(processes.length > 0, "Expected Chromium process memory");
  return {
    elapsedMs: Math.round(performance.now() - start),
    totalRssBytes: processes.reduce((sum, { rssBytes }) => sum + rssBytes, 0),
    processes,
  };
}

const fixture = await receive("pair");
assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(Number.isSafeInteger(fixture.records) && fixture.records >= 512);
assert.equal(fixture.lineBytes, 11);
const browser = await chromium.launch({ headless: true });
let stage = "pairing";
let page;
let sampler;
let sampleError;
let samplePending;
const rss = [];
try {
  const cdp = await browser.newBrowserCDPSession();
  const started = performance.now();
  const sample = () => {
    if (samplePending) return;
    samplePending = processMemory(cdp, started)
      .then((value) => rss.push(value))
      .catch((error) => {
        sampleError ??= error;
      })
      .finally(() => {
        samplePending = undefined;
      });
  };
  sample();
  sampler = setInterval(sample, 2000);
  page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1240, height: 760 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(20_000);
  assert.ok((await page.goto(fixture.url))?.ok());
  const pairing = page.getByLabel(/^(Pairing code|配对码)$/);
  await pairing.fill(fixture.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(pairing).toHaveCount(0, { timeout: 25_000 });

  async function locateOperation(operationId) {
    const activity = page.getByRole("button", {
      name: "Activity",
      exact: true,
    });
    await activity.click();
    const dialog = page.getByRole("dialog", { name: "Activity", exact: true });
    await dialog
      .getByRole("button", { name: `Locate ${operationId}`, exact: true })
      .click({ timeout: 20_000 });
    await expect(dialog).toBeHidden();
  }

  stage = "open live receive from an actual Host operation";
  await locateOperation(fixture.liveOperationId);
  const log = page.getByRole("log", { name: "Receive", exact: true });
  await expect(log).toBeVisible();
  reply("live-ready");

  stage = "observe new RX while recording";
  const live = [];
  let command = await receive();
  while (command.kind === "live-sample") {
    const text = lineText(command.line);
    await expect(log.getByText(text, { exact: true })).toBeInViewport({
      timeout: 20_000,
    });
    const mounted = await log.locator("[data-stream-row-index]").count();
    live.push({ line: command.line, mounted });
    reply("live-visible", { line: command.line });
    command = await receive();
  }
  assert.equal(command.kind, "archive");
  stage = "open the sealed archive";
  await locateOperation(command.operationId);
  const captureTool = page.getByRole("dialog", {
    name: "Capture",
    exact: true,
  });
  if (await captureTool.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(captureTool).toBeHidden();
  }
  const panel = page.getByRole("region", { name: "Replay", exact: true });
  const toggle = panel.getByRole("button", {
    name: "Browse archive",
    exact: true,
  });
  const receiveLog = panel.getByRole("log", { name: "Receive", exact: true });
  const seek = panel.getByRole("textbox", {
    name: "Seek to record",
    exact: true,
  });
  const status = panel.getByRole("status");
  const scroll = [];
  const seeks = [];
  const visible = (line) =>
    expect(
      receiveLog.getByText(lineText(line), { exact: true }),
    ).toBeInViewport();
  async function readRange({ first, last } = {}) {
    const pattern = new RegExp(
      `^(${first ?? "\\d+"})–(${last ?? "\\d+"}) / ${fixture.records}$`,
    );
    await expect(status).toHaveText(pattern);
    const match = (await status.textContent()).match(pattern);
    assert.ok(match);
    const range = { first: Number(match[1]), last: Number(match[2]) };
    assert.ok(
      range.first > 0 &&
        range.last >= range.first &&
        range.last - range.first < 100,
    );
    return range;
  }
  await expect(toggle).toBeEnabled({ timeout: 20_000 });
  await toggle.click();
  const initial = await readRange({ first: 1 });
  await visible(1);

  stage = "scroll and locate while Host records";
  reply("scroll-start");
  assert.equal((await receive("continue")).stage, "scroll");
  const tailStart = fixture.records - 63;
  for (const first of [1, Math.floor(fixture.records / 2), tailStart]) {
    let range = initial;
    if (first !== 1) {
      await seek.fill(String(first));
      const seekStart = performance.now();
      await seek.press("Enter");
      range = await readRange(
        first === tailStart ? { first, last: fixture.records } : { first },
      );
      await visible(first);
      seeks.push({ ...range, latencyMs: performance.now() - seekStart });
    }
    const { last } = range;
    for (const [key, line] of [
      ["End", last],
      ["Home", first],
      ["End", last],
      ["Home", first],
    ]) {
      const before = performance.now();
      await receiveLog.press(key);
      await visible(line);
      scroll.push({ key, line, latencyMs: performance.now() - before });
    }
    assert.ok(
      (await receiveLog.locator("[data-stream-row-index]").count()) <= 100,
    );
  }
  await visible(tailStart);
  await expect(
    panel.getByRole("button", { name: "Next archive page" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Previous archive page" }).click();
  const previous = await readRange({ last: tailStart - 1 });
  await visible(previous.first);
  reply("scroll-done", { scroll, seeks, firstPage: initial, previous });

  stage = "find original byte ranges while Host records";
  reply("search-start");
  assert.equal((await receive("continue")).stage, "search");
  const searches = [];
  for (const line of [17, 97, 313, 487, fixture.records - 9]) {
    await panel.getByRole("button", { name: "Search recording" }).click();
    const dialog = page.getByRole("dialog", { name: "Search recording" });
    const query = lineText(line);
    await dialog.getByRole("textbox", { name: "Search content" }).fill(query);
    const before = performance.now();
    await dialog.getByRole("button", { name: "Start search" }).click();
    const jump = dialog.getByRole("button", { name: "Go to record" });
    await expect(jump).toBeVisible({ timeout: 28 * 60_000 });
    const searchMs = performance.now() - before;
    const start = (line - 1) * fixture.lineBytes;
    const end = start + query.length;
    await expect(
      dialog.getByText(`Record ${line} · bytes [${start}, ${end})`, {
        exact: true,
      }),
    ).toBeVisible();
    await jump.click();
    await expect(dialog).toBeHidden();
    await expect(status).toContainText(`Located record ${line}`);
    await visible(line);
    searches.push({ line, start, end, latencyMs: searchMs });
  }
  reply("search-done", { searches });
  await receive("finish");

  clearInterval(sampler);
  await samplePending;
  if (sampleError) throw sampleError;
  assert.ok(rss.length > 1, "Expected multiple Chromium RSS samples");
  await writeFile(
    join(output, "browser-receipt.json"),
    JSON.stringify(
      {
        viewport: { width: 1240, height: 760 },
        browser: browser.version(),
        live,
        scroll,
        seeks,
        searches,
        rss,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  reply("closed");
} catch (error) {
  console.error(`Million-row browser failed during ${stage}`);
  if (page && stage !== "pairing") {
    const titles = await page
      .getByRole("dialog")
      .getByRole("heading")
      .allTextContents();
    console.error("Active tool dialogs:", titles);
  }
  throw error;
} finally {
  clearInterval(sampler);
  input.close();
  await browser.close();
}
