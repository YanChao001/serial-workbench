/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { session } from "../../src/features/workbench/test-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("ANSI screen interprets split controls and starts a fresh screen after a receive gap", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const input = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (input?.kind !== "source") throw new Error("Missing RX fixture");
  const receive = (data: string, seq: number, start: number) => ({
    kind: "source",
    event: {
      ...input.event,
      eventSeq: String(seq),
      kind: "rx",
      payload: {
        byteStart: String(start),
        byteEnd: String(start + Buffer.byteLength(data)),
        bytesBase64: Buffer.from(data).toString("base64"),
      },
    },
  });
  const emit = (items: unknown[]) =>
    page.evaluate(
      (batch: unknown[]) => window.workbenchFixture.emitRaw(batch),
      items,
    );
  const first = "old\x1b[";
  const tail = "2J\x1b[HAB\x1b[1DZ\x1b[31mR\x1b[0m\nN";
  await emit([receive(first, 10, 0)]);

  const receivePanel = page.getByRole("region", {
    name: "Receive",
    exact: true,
  });
  const options = receivePanel.getByRole("button", { name: "Display options" });
  await options.click();
  await page.getByRole("button", { name: "ANSI terminal" }).click();
  await page.keyboard.press("Escape");
  const screen = page.getByRole("region", { name: "ANSI terminal" });
  const lines = screen.locator(".xterm-rows > div");
  await expect(lines.first()).toContainText("old");

  await emit([receive(tail, 11, first.length)]);
  await expect(lines.first()).toHaveText("AZR");
  await expect(lines.first().locator(".xterm-fg-1")).toHaveText("R");
  await expect(lines.nth(1)).toHaveText("N");
  const indent = () =>
    lines.nth(1).evaluate((line) => line.textContent?.indexOf("N"));
  expect(await indent()).toBe(0);

  await options.click();
  const lf = page.getByRole("switch", { name: "Return to column one on LF" });
  await lf.click();
  await page.keyboard.press("Escape");
  await expect.poll(indent).toBe(3);

  const movements = "\x1b[3;1HA\tB\x1b[2;12H\x1b7\x1b[4;1Hsave\x1b8S";
  await emit([receive(movements, 12, first.length + tail.length)]);
  await expect(lines.nth(3)).toHaveText("save");
  await expect
    .poll(() => lines.nth(2).evaluate((line) => line.textContent?.indexOf("B")))
    .toBe(8);
  await expect
    .poll(() => lines.nth(1).evaluate((line) => line.textContent?.indexOf("S")))
    .toBe(11);

  const alternate = "\x1b[?1049h\x1b[HALT";
  const main = "\x1b[?1049l";
  const position = first.length + tail.length + movements.length;
  await emit([receive(alternate, 13, position)]);
  await expect(lines.first()).toHaveText("ALT");
  await emit([receive(main, 14, position + alternate.length)]);
  await expect(lines.first()).toHaveText("AZR");
  await screen.locator(".xterm-helper-textarea").press("X");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );

  const gap = {
    kind: "reader_gap",
    gap: {
      hostId: input.event.hostId,
      instanceEpoch: input.event.instanceEpoch,
      sessionId: input.event.sessionId,
      sessionEpoch: input.event.sessionEpoch,
      reason: "reader_overflow",
      missingEventRange: { start: "15", end: "16" },
    },
  };
  await emit([gap, receive("NEW", 16, 100)]);
  await expect(lines.first()).toHaveText("NEW");
  await expect(screen).not.toContainText("AZR");
  await receivePanel.getByRole("radio", { name: "HEX", exact: true }).click();
  const log = receivePanel.getByRole("log");
  await expect(
    log.locator('[data-direction="rx"][data-offset="100"]'),
  ).toContainText("4E 45 57");
});

test("ANSI keyboard sends focused keys while shortcuts and device queries stay local", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const panel = page.getByRole("region", { name: "Receive", exact: true });
  await panel.getByRole("button", { name: "Display options" }).click();
  await page.getByRole("button", { name: "ANSI terminal" }).click();
  await page.keyboard.press("Escape");
  const screen = page.getByRole("region", { name: "ANSI terminal" });
  const input = screen.locator(".xterm-helper-textarea");
  const keyboard = screen.getByRole("switch", { name: "Send keyboard input" });
  await expect(keyboard).not.toBeChecked();
  await input.press("X");
  await keyboard.click();
  await expect(input).toBeFocused();

  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const reply = "\x1b[?1h\x1b[5nREADY";
  await page.evaluate((item) => window.workbenchFixture.emitRaw([item]), {
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      payload: {
        byteStart: "0",
        byteEnd: String(reply.length),
        bytesBase64: Buffer.from(reply).toString("base64"),
      },
    },
  });
  await expect(screen.locator(".xterm-rows")).toContainText("READY");
  await input.press("ArrowUp");
  await input.press("F2");
  await input.press("Control+a");
  await input.press("Alt+x");
  await input.press("Tab");

  const sent = async () =>
    Buffer.concat(
      (await page.evaluate(() => window.workbenchFixture.sentBytes)).map(
        (chunk) => Buffer.from(chunk, "base64"),
      ),
    );
  const expected = Buffer.from("\x1bOA\x1bOQ\x01\x1bx\t", "ascii");
  await expect.poll(sent).toEqual(expected);
  await input.press("F1");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shortcuts).toBeHidden();
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(keyboard).toBeFocused();
  await page.keyboard.press("X");
  expect(await sent()).toEqual(expected);
});

test("ANSI clipboard waits for confirmation and submits one paced paste", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedWorkbenchFixture(page, {
    sidebarCollapsed: true,
    language: "en",
    openedConfiguration: {
      ...session().configuration,
      baudRate: "1200",
      dataBits: "8",
      parity: "none",
      stopBits: "one",
    },
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const panel = page.getByRole("region", { name: "Receive", exact: true });
  await panel.getByRole("button", { name: "Display options" }).click();
  await page.getByRole("button", { name: "ANSI terminal" }).click();
  await page.keyboard.press("Escape");
  const screen = page.getByRole("region", { name: "ANSI terminal" });
  const input = screen.locator(".xterm-helper-textarea");
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const rx = "\x1b[?2004hREADY";
  await page.evaluate((item) => window.workbenchFixture.emitRaw([item]), {
    kind: "source",
    event: {
      ...source.event,
      payload: {
        byteStart: "0",
        byteEnd: String(rx.length),
        bytesBase64: Buffer.from(rx).toString("base64"),
      },
    },
  });
  await expect(screen.locator(".xterm-rows")).toContainText("READY");
  await screen.getByRole("switch", { name: "Send keyboard input" }).click();
  await expect(input).toBeFocused();
  const pasteCalls = () =>
    page.evaluate(() =>
      window.workbenchFixture.invocations.filter(
        (call) =>
          call.actionId === "transfer.paste" || call.actionId === "session.tx",
      ),
    );
  const group = screen.getByRole("group", { name: "Send paste" });
  const brackets = group.getByRole("switch", {
    name: "Use bracketed paste for this send",
  });
  const clipboard = "a\r\nb\n" + "x".repeat(1200);
  const payload = Buffer.from("a\rb\r" + "x".repeat(1200));
  const pacing = {
    chunkBytes: "12",
    bytesPerSecond: "120",
    interChunkMs: "20",
  };
  const paste = async () => {
    await input.focus();
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      clipboard,
    );
    await input.press("ControlOrMeta+v");
    await expect(group).toBeVisible();
  };

  await paste();
  await expect(brackets).toBeChecked();
  await expect(group.getByRole("status")).toHaveText("Bytes to send 1216");
  const confirmation = await group.boundingBox();
  const terminal = await screen.locator(".workbench-ansi-screen").boundingBox();
  expect(confirmation).not.toBeNull();
  expect(terminal).not.toBeNull();
  if (!confirmation || !terminal) throw new Error("Missing ANSI layout");
  expect(confirmation.y + confirmation.height).toBeLessThanOrEqual(terminal.y);
  expect(await pasteCalls()).toEqual([]);
  await group.getByRole("button", { name: "Cancel" }).click();
  await expect(group).toBeHidden();
  expect(await pasteCalls()).toEqual([]);

  await paste();
  await brackets.click();
  await expect(group.getByRole("status")).toHaveText("Bytes to send 1204");
  await group.getByRole("button", { name: "Send paste" }).click();
  await expect(screen.getByRole("status")).toHaveText(
    "Paste sent. Bytes written 1204",
  );
  const calls = await pasteCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    actionId: "transfer.paste",
    executionMode: "independent",
    target: { sessionId: "session", sessionEpoch: "1" },
    params: {
      ...pacing,
      bytesBase64: payload.toString("base64"),
    },
  });
  await paste();
  await expect(group).toBeFocused();
  await group.getByRole("button", { name: "Send paste" }).click();
  await expect(screen.getByRole("status")).toHaveText(
    "Paste sent. Bytes written 1216",
  );
  const wrapped = Buffer.concat([
    Buffer.from("\x1b[200~"),
    payload,
    Buffer.from("\x1b[201~"),
  ]);
  const orderedCalls = await pasteCalls();
  expect(orderedCalls).toHaveLength(2);
  expect(orderedCalls[1]).toMatchObject({
    params: { ...pacing, bytesBase64: wrapped.toString("base64") },
  });
});
