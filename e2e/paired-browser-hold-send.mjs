import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const [output] = process.argv.slice(2);
assert.ok(output, "Missing hold-send proof directory");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const line = await input[Symbol.asyncIterator]().next();
assert.ok(!line.done, "Missing Host pairing");
const fixture = JSON.parse(line.value);
input.close();
assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 420, height: 610 },
    reducedMotion: "reduce",
  });
  const requests = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const request = JSON.parse(payload).body?.request;
      const call = request?.params;
      if (
        request?.method === "action.invoke" &&
        call?.actionId === "session.tx"
      ) {
        requests.push({
          requestId: call.requestId,
          expectedRevision: call.expectedRevision,
          bytesBase64: call.params.bytesBase64,
        });
      }
    });
  });
  assert.ok((await page.goto(fixture.url))?.ok());
  const pairing = page.getByLabel(/^(Pairing code|配对码)$/);
  await expect(pairing).toBeVisible();
  const pairingLanguage =
    (await page.getByLabel("配对码").count()) === 1 ? "zh-CN" : "en";
  await pairing.fill(fixture.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(pairing).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Choose device", exact: true })
    .click();
  await page.getByRole("option", { name: "virtual:echo", exact: true }).click();
  const open = page.getByRole("button", {
    name: "Open virtual:echo",
    exact: true,
  });
  const connected = page.getByRole("button", {
    name: "Close session",
    exact: true,
  });
  await expect(open.or(connected)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(connected).toBeVisible();
  const send = page.getByRole("region", { name: "Send", exact: true });
  const draft = send.getByRole("textbox", { name: "Send draft", exact: true });
  const hold = send.getByRole("button", {
    name: "Hold to repeat sending",
    exact: true,
  });
  await draft.fill("AT");
  await expect(hold).toBeEnabled();
  assert.equal(requests.length, 0);
  await hold.focus();
  await page.keyboard.down("Space");
  await expect.poll(() => requests.length, { intervals: [15, 20, 25] }).toBe(2);
  await page.keyboard.up("Space");
  await expect(hold).not.toHaveAttribute("aria-busy");
  await send.getByRole("button", { name: "Receipt", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Receipt", exact: true }),
  ).toContainText("Completed");
  // 最终回执后再等待两个间隔，验证没有遗留计时器。
  await page.waitForTimeout(400);
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map(({ requestId }) => requestId)).size, 2);
  assert.ok(
    requests.every(
      ({ bytesBase64, expectedRevision }) =>
        bytesBase64 === "QVQ=" &&
        /^\d+$/.test(expectedRevision) &&
        expectedRevision === requests[0].expectedRevision,
    ),
  );
  await expect(draft).toHaveValue("AT");
  await writeFile(
    join(output, "browser-receipt.json"),
    JSON.stringify(
      { pairingLanguage, requests, released: true, draft: "AT" },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
