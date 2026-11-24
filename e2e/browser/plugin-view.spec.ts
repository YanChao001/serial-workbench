import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {
  RawBatch,
  RawEvent,
  SessionSnapshot,
} from "@serial-workbench/contracts";

const example = "packages/plugin-sdk/examples/reference-terminal";
const shellOrigin = "https://plugin-shell.example";
const assetOrigin = "https://plugin-assets.example";
const identity = "a".repeat(43);

test("signed monitor renderer accepts scoped read-only batches in an opaque iframe", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 240 });
  const [shell, shellCss, html, css, bundle, fixturesJson] = await Promise.all([
    readFile("src-tauri/src/node_view/shell.js", "utf8"),
    readFile("src-tauri/src/node_view/shell.css", "utf8"),
    readFile(`${example}/index.html`, "utf8"),
    readFile(`${example}/view.css`, "utf8"),
    build({
      entryPoints: [`${example}/view.ts`],
      bundle: true,
      write: false,
      format: "iife",
    }),
    readFile("packages/contracts/src/generated/fixtures.json", "utf8"),
  ]);
  const fixtures = JSON.parse(fixturesJson) as {
    valid: { name: string; value: unknown }[];
  };
  const session = fixtures.valid.find(
    (fixture) => fixture.name === "session-snapshot",
  )!.value as SessionSnapshot;
  const batch = fixtures.valid.find(
    (fixture) => fixture.name === "raw-source-batch",
  )!.value as RawBatch;
  const overflow = fixtures.valid.find(
    (fixture) => fixture.name === "raw-reader-gap-batch",
  )!.value as RawBatch;
  const tx = fixtures.valid.find((fixture) => fixture.name === "raw-tx-final")!
    .value as RawEvent;
  const item = batch.items[0];
  if (item?.kind !== "source" || item.event?.kind !== "rx")
    throw new Error("Missing RX fixture");
  if (tx.kind !== "tx") throw new Error("Missing TX fixture");
  const gap = overflow.items[0];
  if (gap?.kind !== "reader_gap") throw new Error("Missing reader gap fixture");
  const browserScript = bundle.outputFiles[0]?.text;
  if (!browserScript) throw new Error("Missing terminal view bundle");
  const marker = '<img src="https://unexpected.example/" onerror="alert(1)">';
  item.event.sessionEpoch = session.sessionEpoch;
  const rxLine = `${marker}\n`;
  const txLine = "X\r\n";
  const firstRead = `${marker}\r`;
  item.event.payload.bytesBase64 = Buffer.from(firstRead).toString("base64");
  item.event.payload.byteEnd = String(Buffer.byteLength(firstRead));
  const lineEnd = (BigInt(item.event.payload.byteEnd) + 1n).toString();
  const txPosition = (BigInt(batch.cursor.position) + 1n).toString();
  batch.items.push({
    kind: "source",
    event: {
      ...tx,
      eventSeq: txPosition,
      sessionEpoch: session.sessionEpoch,
      payload: {
        ...tx.payload,
        bytesBase64: Buffer.from(txLine).toString("base64"),
        byteEnd: String(Buffer.byteLength(txLine)),
      },
    },
  });
  batch.cursor.position = txPosition;
  const continuationPosition = (BigInt(txPosition) + 1n).toString();
  const continuation: RawBatch = {
    ...batch,
    previousCursor: batch.cursor,
    cursor: { ...batch.cursor, position: continuationPosition },
    items: [
      {
        kind: "source",
        event: {
          ...item.event,
          eventSeq: continuationPosition,
          payload: {
            ...item.event.payload,
            bytesBase64: "Cg==",
            byteStart: item.event.payload.byteEnd,
            byteEnd: lineEnd,
          },
        },
      },
    ],
  };
  const frame = {
    requestId: "33333333-3333-4333-8333-333333333333",
    channel: "raw",
    body: { type: "rawBatch", batch },
  };
  const afterGap = "serial data after recovery";
  const finalRead = `${afterGap}\r`;
  const missing = {
    start: (BigInt(continuationPosition) + 1n).toString(),
    end: (BigInt(continuationPosition) + 4n).toString(),
  };
  overflow.previousCursor = continuation.cursor;
  overflow.cursor.position = missing.end;
  gap.gap.sessionEpoch = session.sessionEpoch;
  gap.gap.missingEventRange = missing;
  const byteStart = lineEnd;
  overflow.items.push({
    kind: "source",
    event: {
      ...item.event,
      eventSeq: missing.end,
      payload: {
        ...item.event.payload,
        bytesBase64: Buffer.from(finalRead).toString("base64"),
        byteStart,
        byteEnd: (
          BigInt(byteStart) + BigInt(Buffer.byteLength(finalRead))
        ).toString(),
      },
    },
  });
  const payloads = [
    { snapshot: session },
    { frame },
    { frame: { ...frame, body: { ...frame.body, batch: continuation } } },
    { frame: { ...frame, body: { ...frame.body, batch: overflow } } },
    { frame: null },
  ];
  let pulls = 0;
  let stops = 0;
  let dataReady = false;
  const unexpected: string[] = [];
  await page.route("https://unexpected.example/**", (route) => {
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route(`${shellOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/index.html") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy": `default-src 'none'; script-src ${shellOrigin}; style-src ${shellOrigin}; frame-src ${assetOrigin}; form-action 'none'`,
        },
        body: `<!doctype html><html lang="zh-CN"><head><meta name="color-scheme" content="dark"><link rel="stylesheet" href="shell.css"><script defer src="shell.js"></script></head>
          <body data-frame="${identity}"><p role="status">Opening plugin view…</p>
          <template><iframe sandbox="allow-scripts" title="Plugin view" referrerpolicy="no-referrer"
            data-src="${assetOrigin}/index.html#${identity}.zh-CN.dark.locale"></iframe></template></body></html>`,
      });
    }
    if (path === "/shell.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: shell,
      });
    if (path === "/shell.css")
      return route.fulfill({
        contentType: "text/css; charset=utf-8",
        body: shellCss,
      });
    if (path === "/next.js") {
      const payload = (pulls === 0 || dataReady
        ? payloads[pulls++]
        : undefined) ?? { frame: null };
      return route.fulfill({
        contentType: "application/javascript",
        body: `globalThis.swbViewReceive(JSON.parse(${JSON.stringify(JSON.stringify(payload))}));`,
      });
    }
    if (path === "/stop.js") stops += 1;
    return route.fulfill({ contentType: "application/javascript", body: "" });
  });
  await page.route(`${assetOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = {
      "content-security-policy": `sandbox allow-scripts; default-src 'none'; script-src ${assetOrigin}; style-src ${assetOrigin}; form-action 'none'`,
    };
    if (path === "/index.html")
      return route.fulfill({ headers, contentType: "text/html", body: html });
    if (path === "/view.css")
      return route.fulfill({ headers, contentType: "text/css", body: css });
    if (path === "/view.js")
      return route.fulfill({
        headers,
        contentType: "application/javascript",
        body: browserScript,
      });
    return route.fulfill({ status: 404 });
  });

  await page.goto(`${shellOrigin}/index.html`);
  const view = page.frameLocator('iframe[title="Plugin view"]');
  await expect(view.getByRole("status")).toHaveText("等待串口数据…");
  await expect(page.getByRole("status")).toBeHidden();
  const frameBox = await page.locator("iframe").boundingBox();
  expect(frameBox).toEqual({ x: 0, y: 0, width: 360, height: 240 });
  dataReady = true;
  await expect(view.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(view.locator("#receive")).toHaveJSProperty(
    "textContent",
    `${rxLine}[TX] X\n[部分串口数据缺失]\n${afterGap}\n`,
  );
  await expect(view.getByRole("heading")).toHaveCount(0);
  await expect(view.getByRole("status")).toBeHidden();
  await expect(view.locator("#receive img")).toHaveCount(0);
  expect(await view.locator("html").evaluate(() => globalThis.origin)).toBe(
    "null",
  );
  expect(unexpected).toEqual([]);
  await expect.poll(() => pulls).toBeGreaterThanOrEqual(5);

  const changeShellLanguage = (locale: "en" | "zh-CN") =>
    page.evaluate((language) => {
      const shell = globalThis as typeof globalThis & {
        swbViewSetLocale: (value: typeof language) => void;
      };
      shell.swbViewSetLocale(language);
    }, locale);
  await changeShellLanguage("en");
  await expect(view.locator("html")).toHaveAttribute("lang", "en");
  await changeShellLanguage("zh-CN");
  await expect(view.locator("html")).toHaveAttribute("lang", "zh-CN");

  await view.locator("html").evaluate(() => location.reload());
  const stopped = page.getByRole("status");
  await expect(stopped).toContainText("视图已停止（FRAME_CHANGED）");
  await expect(stopped).toContainText("请关闭此窗口，再从工作台重新打开视图。");
  await expect(page.locator("iframe")).toHaveCount(0);
  const narrow = await stopped.boundingBox();
  if (!narrow) throw new Error("Missing plugin view status geometry");
  expect(narrow.x).toBeGreaterThanOrEqual(16);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(344);
  expect(narrow.y + narrow.height / 2).toBeCloseTo(120, 0);
  await page.screenshot({
    path: info.outputPath("plugin-window-stopped-360.png"),
  });

  await page.setViewportSize({ width: 1000, height: 600 });
  await changeShellLanguage("en");
  await expect(stopped).toContainText("View stopped (FRAME_CHANGED)");
  await expect(stopped).toContainText(
    "Close this window and reopen the view from the workbench.",
  );
  const wide = await stopped.boundingBox();
  if (!wide) throw new Error("Missing plugin view status at wide width");
  expect(wide.width).toBeLessThanOrEqual(480);
  expect(wide.x + wide.width / 2).toBeCloseTo(500, 0);
  await expect.poll(() => stops).toBe(1);
});
