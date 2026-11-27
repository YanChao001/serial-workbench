import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { browser } from "@wdio/globals";

const execute = promisify(execFile);
const xdo = async (...args) =>
  (await execute("xdotool", args, { timeout: 5000 })).stdout.trim();

function viewportPoint(selector) {
  return browser.execute((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error("Missing file drop target");
    element.scrollIntoView({ block: "nearest" });
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !element.contains(hit))
      throw new Error("File drop target is not visible at its center");
    return {
      x: Math.round(x * devicePixelRatio),
      y: Math.round(y * devicePixelRatio),
      pixelRatio: devicePixelRatio,
    };
  }, selector);
}

async function dropFilesOnX11(binary, selector, paths) {
  const point = await viewportPoint(selector);
  const targetWindow = await xdo("getactivewindow");
  assert.match(await xdo("getwindowname", targetWindow), /Serial Workbench/i);
  const title = "SWB X11 file source " + randomUUID();
  const source = spawn(binary, [title, ...paths], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let offered = "";
  let diagnostic = "";
  source.stdout.setEncoding("utf8").on("data", (chunk) => (offered += chunk));
  source.stderr
    .setEncoding("utf8")
    .on("data", (chunk) => (diagnostic += chunk));
  const finished = once(source, "close");
  void finished.catch(() => {});
  try {
    const sourceWindow = await xdo(
      "search",
      "--onlyvisible",
      "--sync",
      "--name",
      "^" + title + "$",
    );
    await xdo("windowmove", "--sync", sourceWindow, "24", "32");
    await xdo("windowactivate", "--sync", sourceWindow);
    try {
      await xdo(
        "mousemove",
        "--sync",
        "--window",
        sourceWindow,
        "64",
        "32",
        "mousedown",
        "1",
        "sleep",
        "0.15",
        "mousemove",
        "--sync",
        "--window",
        sourceWindow,
        "95",
        "32",
        "sleep",
        "0.2",
        "mousemove",
        "--sync",
        "--window",
        targetWindow,
        String(point.x),
        String(point.y),
        "sleep",
        "0.5",
        "mouseup",
        "1",
      );
    } catch (error) {
      await xdo("mouseup", "1").catch(() => {});
      throw error;
    }
    const [code, signal] = await Promise.race([
      finished,
      delay(5000, undefined, { ref: false }).then(() => {
        throw new Error("The GTK drag did not finish: " + diagnostic);
      }),
    ]);
    assert.equal(code, 0, diagnostic || String(signal));
    assert.match(
      offered,
      /^file-drag-started$/m,
      JSON.stringify({ selector, point }),
    );
    return { ...point, fileDataOffered: /^file-uris-offered$/m.test(offered) };
  } finally {
    if (source.exitCode === null && source.signalCode === null) source.kill();
    await finished.catch(() => {});
    await xdo("windowactivate", "--sync", targetWindow);
  }
}

async function dropFilesOnDesktop(binary, selector, paths) {
  const point = await viewportPoint(selector);
  const destination =
    process.platform === "darwin"
      ? await browser.execute(async ({ x, y }) => {
          const win = window.__TAURI__.window.getCurrentWindow();
          const [origin, scale] = await Promise.all([
            win.outerPosition(),
            win.scaleFactor(),
          ]);
          // macOS 的 Overlay 标题栏让工作台填满窗口；CoreGraphics 在 Retina 上也使用屏幕点。
          return { x: (origin.x + x) / scale, y: (origin.y + y) / scale };
        }, point)
      : point;
  try {
    const { stdout } = await execute(
      binary,
      [String(destination.x), String(destination.y), ...paths],
      { timeout: 12000, windowsHide: true },
    );
    assert.match(stdout, /^file-drag-started\r?$/m);
    return {
      ...point,
      fileDataOffered: true,
      nativeCopyAccepted: /^file-data-accepted\r?$/m.test(stdout),
    };
  } finally {
    await browser.execute(() =>
      window.__TAURI__.window.getCurrentWindow().setFocus(),
    );
  }
}

export function fileDropDriver() {
  if (process.platform === "linux" && process.env.SWB_E2E_X11_FILE_DRAG) {
    const binary = process.env.SWB_E2E_X11_FILE_DRAG;
    return { platform: "x11", dropFiles: dropFilesOnX11.bind(null, binary) };
  }
  if (
    (process.platform === "darwin" || process.platform === "win32") &&
    process.env.SWB_E2E_FILE_DRAG
  ) {
    const binary = process.env.SWB_E2E_FILE_DRAG;
    return {
      platform: process.platform === "darwin" ? "macos" : "windows",
      dropFiles: dropFilesOnDesktop.bind(null, binary),
    };
  }
}
