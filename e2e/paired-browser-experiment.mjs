import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const [output] = process.argv.slice(2);
assert.ok(output, "Missing experiment evidence directory");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const line = await input[Symbol.asyncIterator]().next();
assert.ok(!line.done, "Missing isolated Host fixture");
const fixture = JSON.parse(line.value);
input.close();
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const experimentTitle = /^(Experiment package|复现实验包)$/;
const workspaceTitle = /^(Workspace|工作区)$/;
let stage = "pairing";
let currentPage;
let paired = false;

function recordActions(page) {
  const requests = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { request } = JSON.parse(payload).body;
      const actionId = request?.params?.actionId;
      if (
        actionId === "workspace.save" ||
        actionId === "device.rebind" ||
        actionId?.startsWith("workspace.experiment.")
      )
        requests.push(actionId);
    });
  });
  return requests;
}

async function openTool(page, title) {
  const menu = page.getByRole("button", {
    name: /^(Workspace menu|工作区菜单)$/,
  });
  await expect(menu).toBeEnabled({ timeout: 15_000 });
  const direct = page.getByRole("button", { name: title });
  if (await direct.isVisible()) await direct.click();
  else {
    await menu.press("ArrowDown");
    await page.getByRole("menuitem", { name: title }).click();
  }
  return page.getByRole("dialog", { name: title });
}

async function openExperiment(entry, viewport) {
  assert.match(entry.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await browser.newPage({
    acceptDownloads: true,
    locale: "en-US",
    viewport,
    reducedMotion: "reduce",
  });
  currentPage = page;
  paired = false;
  const requests = recordActions(page);
  await page.goto(entry.url);
  const code = page.getByLabel(/^(Pairing code|配对码)$/);
  await code.fill(entry.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(code).toHaveCount(0, { timeout: 30_000 });
  paired = true;

  const dialog = await openTool(page, workspaceTitle);
  await dialog.getByRole("button", { name: experimentTitle }).click();
  const tool = dialog.getByRole("region", { name: experimentTitle });
  await expect(tool).toBeVisible();
  return { page, dialog, tool, requests };
}

try {
  stage = "export on source Host";
  const source = await openExperiment(fixture.source, {
    width: 1240,
    height: 760,
  });
  const parserChoices = source.tool.getByRole("group", {
    name: /^(Parser plug-ins|解析器插件)$/,
  });
  await parserChoices
    .getByRole("checkbox", { name: "Serial Workbench Framing" })
    .check();
  await expect(
    parserChoices.getByRole("checkbox", { name: /Automation|自动化/i }),
  ).toHaveCount(0);
  await source.tool
    .getByRole("checkbox", { name: fixture.recording.id, exact: true })
    .check();
  await source.tool
    .getByRole("textbox", { name: /Firmware versions|固件版本/ })
    .fill("v1.4.2");
  await source.tool
    .getByRole("button", { name: /^(Preview export|预览导出)$/ })
    .click();
  await expect(
    source.tool.getByText("115200 / 8N1", { exact: true }),
  ).toBeVisible();
  await expect(
    source.tool.getByText("swb.reference.framing 0.1.0", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(source.requests, ["workspace.experiment.export"]);
  await source.dialog.screenshot({ path: join(output, "source-export.png") });

  const [downloaded] = await Promise.all([
    source.page.waitForEvent("download"),
    source.tool
      .getByRole("button", { name: /^(Save package|保存实验包)$/ })
      .click(),
  ]);
  const exportedPath = join(output, "experiment-package.json");
  await downloaded.saveAs(exportedPath);
  const raw = await readFile(exportedPath, "utf8");
  const exported = JSON.parse(raw);
  assert.equal(exported.formatVersion, "1");
  assert.deepEqual(exported.firmware, [{ binding: 1, version: "v1.4.2" }]);
  assert.deepEqual(exported.recordings[0].reference, fixture.recording);
  assert.match(exported.recordings[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(exported.parsers[0].id, "swb.reference.framing");
  assert.equal(exported.workspace.bindings[0].hostId, "experiment-unbound");
  assert.equal(exported.workspace.bindings[0].reconnect.enabled, false);
  for (const privateValue of [
    "Private source bench",
    "Private view",
    "private-binding",
    "private-port",
    "private-serial",
    "private-topology",
    "private-recording-directory",
    "QUJD",
  ]) {
    assert.ok(!raw.includes(privateValue), `Export leaked ${privateValue}`);
  }
  assert.deepEqual(source.requests, [
    "workspace.experiment.export",
    "workspace.experiment.export",
  ]);
  await source.page.close();

  stage = "inspect on receiving Host";
  const destination = await openExperiment(fixture.destination, {
    width: 420,
    height: 540,
  });
  await expect(
    destination.tool.locator(".workbench-experiment-context"),
  ).toContainText(fixture.destinationName);
  await destination.tool
    .getByRole("button", { name: /^(Import package|导入实验包)$/ })
    .click();
  const [chooser] = await Promise.all([
    destination.page.waitForEvent("filechooser"),
    destination.tool
      .getByRole("button", { name: /^(Choose package file|选择实验包文件)$/ })
      .click(),
  ]);
  await chooser.setFiles(exportedPath);
  await expect(
    destination.tool.getByText(/^\s*(Missing|缺失)\s*$/),
  ).toBeVisible();
  await expect(
    destination.tool.getByText(/^\s*(Other Host|其他 Host)\s*$/),
  ).toBeVisible();
  await expect(
    destination.tool.getByText(/^\s*(Needs rebinding|等待重新绑定)\s*$/),
  ).toBeVisible();
  assert.deepEqual(destination.requests, ["workspace.experiment.inspect"]);
  await destination.tool
    .getByText(/^\s*(Other Host|其他 Host)\s*$/)
    .scrollIntoViewIfNeeded();
  await destination.dialog.screenshot({
    path: join(output, "destination-inspect.png"),
  });

  stage = "confirm import";
  await destination.tool
    .getByRole("button", { name: /^(Confirm import|确认导入)$/ })
    .click();
  await expect(
    destination.tool.getByText(/Imported the configuration|实验包配置已导入/),
  ).toBeVisible();
  assert.deepEqual(destination.requests, [
    "workspace.experiment.inspect",
    "workspace.save",
  ]);

  stage = "rebind on receiving Host";
  await destination.dialog.press("Escape");
  await expect(destination.dialog).toHaveCount(0);
  const devices = await openTool(destination.page, /^(Devices|设备)$/);
  await devices.getByRole("tab", { name: /^(Favorites|连接收藏)$/ }).click();
  await expect(devices.getByText(/Offline device|离线设备/)).toBeVisible();
  const confirm = devices.getByRole("button", {
    name: /^(Confirm device binding|确认设备绑定) /,
  });
  await expect(confirm).toBeDisabled();
  await devices
    .getByRole("combobox", { name: /^(Choose device|选择设备) / })
    .click();
  await destination.page
    .getByRole("option", { name: "virtual:echo", exact: true })
    .click();
  assert.deepEqual(destination.requests, [
    "workspace.experiment.inspect",
    "workspace.save",
  ]);
  await confirm.click();
  await expect(devices.getByText(/View 1 · virtual:echo/)).toBeVisible();
  assert.deepEqual(destination.requests, [
    "workspace.experiment.inspect",
    "workspace.save",
    "device.rebind",
  ]);
  await devices.screenshot({ path: join(output, "destination-rebound.png") });

  await writeFile(
    join(output, "browser-receipt.json"),
    JSON.stringify(
      {
        sourceActions: source.requests,
        destinationActions: destination.requests,
        formatVersion: exported.formatVersion,
        parserStatus: "missing",
        recordingStatus: "other_host",
        excludedNonParserPackages: true,
        redactedPackageDownloaded: true,
        destinationNamePreserved: true,
        destinationDeviceReboundExplicitly: true,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  if (paired && currentPage && !currentPage.isClosed())
    await currentPage.screenshot({ path: join(output, "failure.png") });
  throw new Error(`Experiment exchange failed during ${stage}`, {
    cause: error,
  });
} finally {
  await browser.close();
}
