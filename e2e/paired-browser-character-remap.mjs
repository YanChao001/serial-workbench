import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const [output] = process.argv.slice(2);
assert.ok(output, "Missing remap evidence directory");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const hostSignals = input[Symbol.asyncIterator]();
const line = await hostSignals.next();
assert.ok(!line.done, "Missing Host fixture");
const fixture = JSON.parse(line.value);
assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
let stage = "pairing";
try {
  const page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 1240, height: 780 },
    reducedMotion: "reduce",
  });
  assert.ok((await page.goto(fixture.url))?.ok());
  const pairing = page.getByLabel(/^(Pairing code|配对码)$/);
  await pairing.fill(fixture.pairingCode);
  await page.getByRole("button", { name: /^(Connect|连接)$/ }).click();
  await expect(pairing).toHaveCount(0, { timeout: 15_000 });

  stage = "attach to signed TCP";
  const device = page.getByRole("combobox", {
    name: "Choose device",
    exact: true,
  });
  await device.click();
  const choice = page.getByRole("option").filter({
    has: page.locator(`[title=${JSON.stringify(fixture.systemName)}]`),
  });
  await choice.click();
  const connection = page.getByRole("button", { name: /^Open / });
  await connection.click();
  const transport = page.getByRole("dialog", {
    name: "TCP connection",
    exact: true,
  });
  await transport
    .getByRole("textbox", { name: "Port", exact: true })
    .fill(String(fixture.port));
  await transport.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(transport).toBeHidden({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeVisible();
  process.stdout.write("tcp-connected\n");
  const ready = await hostSignals.next();
  assert.equal(ready.value, "recording-ready");
  input.close();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();

  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  const dialog = page.getByRole("dialog", {
    name: "Character remapping",
    exact: true,
  });
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const send = page.getByRole("region", { name: "Send", exact: true });
  const draft = send.getByRole("textbox", { name: "Send draft" });
  async function remapping() {
    await menu.press("ArrowDown");
    await page
      .getByRole("menuitem", { name: "Character remapping", exact: true })
      .click();
  }
  async function select(field, value) {
    await dialog.getByRole("combobox", { name: field, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }

  stage = "apply RX rules on an idle live subscription";
  await remapping();
  await select("Newlines", "LF");
  await select("Backspace", "Erase previous character");
  await select("Letter case", "Uppercase");
  await dialog
    .getByRole("button", { name: "Apply to receive", exact: true })
    .click({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(
    terminal.getByRole("radio", { name: "Mapped", exact: true }),
  ).toBeChecked();
  await expect(
    terminal.getByText("Waiting for received text to map."),
  ).toBeVisible();
  process.stdout.write("mapped-receive-ready\n");

  stage = "compare mapped RX to original peer bytes";
  const display = terminal.locator("[data-rx-mapped-text]");
  await expect
    .poll(() => display.textContent(), { timeout: 15_000 })
    .toBe("RX=2\nOK\nNEXT\n!");
  await terminal.screenshot({ path: join(output, "real-mapped-receive.png") });
  await terminal
    .getByRole("button", { name: "Original bytes", exact: true })
    .click();
  await expect(
    terminal.getByRole("radio", { name: "HEX", exact: true }),
  ).toBeChecked();
  await expect(terminal.getByRole("log")).toContainText(
    "72 78 3D 31 08 32 0D 0A 6F 6B 0D 6E 65 78 74 0A 21",
  );

  stage = "apply TX rules and send exactly once";
  await draft.fill("ab\nline");
  await remapping();
  await dialog
    .getByRole("radio", { name: "Send preview", exact: true })
    .click();
  await select("Newlines", "CRLF");
  await select("Letter case", "Uppercase");
  await dialog
    .getByRole("button", { name: "Add replacement", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Source character", exact: true })
    .fill("a");
  await dialog
    .getByRole("textbox", { name: "Replacement text", exact: true })
    .fill("z");
  await expect(
    dialog.getByRole("textbox", { name: "After mapping", exact: true }),
  ).toHaveValue("ZB\\r\\nLINE");
  await dialog
    .getByRole("button", { name: "Apply to send", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 420, height: 610 });
  await expect(send.getByText("Send mapping active")).toBeVisible();
  await expect(send.locator(".workbench-draft-bytes")).toHaveText("8 B");
  await send.screenshot({ path: join(output, "real-mapped-send.png") });
  await send.getByRole("button", { name: "Send", exact: true }).click();
  await expect(draft).toHaveValue("ab\nline");
  await page.setViewportSize({ width: 1240, height: 780 });
  const receipt = send.getByRole("button", { name: "Receipt", exact: true });
  await expect(receipt).toBeEnabled({ timeout: 15_000 });
  await receipt.click();
  await expect(page.getByRole("status", { name: "Receipt" })).toContainText(
    "Completed",
    { timeout: 15_000 },
  );
  await writeFile(
    join(output, "browser-receipt.json"),
    JSON.stringify(
      {
        linkedOriginalRx: true,
        mappedReceive: "RX=2\nOK\nNEXT\n!",
        mappedTransmitBytes: 8,
        originalDraft: "ab\nline",
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  throw new Error("Paired remap stopped at " + stage, { cause: error });
} finally {
  await browser.close();
}
