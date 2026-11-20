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
}) => {
  const [shell, html, css, bundle, fixturesJson] = await Promise.all([
    readFile("src-tauri/src/node_view/shell.js", "utf8"),
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
  const txLine = "X\n";
  item.event.payload.bytesBase64 = Buffer.from(rxLine).toString("base64");
  item.event.payload.byteEnd = String(Buffer.byteLength(rxLine));
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
      },
    },
  });
  batch.cursor.position = txPosition;
  const frame = {
    requestId: "33333333-3333-4333-8333-333333333333",
    channel: "raw",
    body: { type: "rawBatch", batch },
  };
  const afterGap = "serial data after recovery";
  const missing = {
    start: (BigInt(batch.cursor.position) + 1n).toString(),
    end: (BigInt(batch.cursor.position) + 4n).toString(),
  };
  overflow.previousCursor = batch.cursor;
  overflow.cursor.position = missing.end;
  gap.gap.sessionEpoch = session.sessionEpoch;
  gap.gap.missingEventRange = missing;
  const byteStart = item.event.payload.byteEnd;
  overflow.items.push({
    kind: "source",
    event: {
      ...item.event,
      eventSeq: missing.end,
      payload: {
        ...item.event.payload,
        bytesBase64: Buffer.from(afterGap).toString("base64"),
        byteStart,
        byteEnd: (
          BigInt(byteStart) + BigInt(Buffer.byteLength(afterGap))
        ).toString(),
      },
    },
  });
  const payloads = [
    { snapshot: session },
    { frame },
    { frame: { ...frame, body: { ...frame.body, batch: overflow } } },
    { frame: null },
  ];
  let pulls = 0;
  let stops = 0;
  const unexpected: string[] = [];
  await page.route("https://unexpected.example/**", (route) => {
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route(`${shellOrigin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/index.html") {
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "content-security-policy": `default-src 'none'; script-src ${shellOrigin}; frame-src ${assetOrigin}; form-action 'none'`,
        },
        body: `<!doctype html><html lang="en"><script defer src="shell.js"></script>
          <body data-frame="${identity}"><p role="status">Opening plugin view…</p>
          <template><iframe sandbox="allow-scripts" title="Plugin view" referrerpolicy="no-referrer"
            data-src="${assetOrigin}/index.html#${identity}.zh-CN.dark"></iframe></template></body></html>`,
      });
    }
    if (path === "/shell.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: shell,
      });
    if (path === "/next.js") {
      const payload = payloads[pulls++] ?? { frame: null };
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
  await expect(view.getByRole("heading", { name: "串口监听" })).toBeVisible();
  await expect(view.getByRole("status")).toHaveText("正在监听");
  await expect(view.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(view.locator("#receive")).toHaveJSProperty(
    "textContent",
    `${rxLine}[TX] ${txLine}[部分串口数据缺失]\n${afterGap}`,
  );
  await expect(view.locator("#receive img")).toHaveCount(0);
  expect(await view.locator("html").evaluate(() => globalThis.origin)).toBe(
    "null",
  );
  expect(unexpected).toEqual([]);
  await expect.poll(() => pulls).toBeGreaterThanOrEqual(4);

  await view.locator("html").evaluate(() => location.reload());
  await expect(page.getByRole("status")).toHaveText(
    "View stopped (FRAME_CHANGED)",
  );
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => stops).toBe(1);
});
