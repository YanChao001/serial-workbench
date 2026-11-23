/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

async function openAnsi(page: Page) {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  await page
    .getByRole("region", { name: "Receive", exact: true })
    .getByRole("button", { name: "Display options" })
    .click();
  await page.getByRole("button", { name: "ANSI terminal" }).click();
  await page.keyboard.press("Escape");
  const viewer = page.getByRole("region", { name: "ANSI terminal" });
  const terminal = viewer.locator(".xterm");
  const rows = terminal.locator(".xterm-rows");
  const input = terminal.locator(".xterm-helper-textarea");
  await expect(input).toBeAttached();
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  let next = Number(source.event.eventSeq);
  let offset = 0;
  return {
    viewer,
    terminal,
    rows,
    input,
    async feed(text: string, afterGap = false) {
      const bytes = Buffer.from(text);
      const batch: unknown[] = [];
      if (afterGap) {
        batch.push({
          kind: "reader_gap",
          gap: {
            hostId: source.event.hostId,
            instanceEpoch: source.event.instanceEpoch,
            sessionId: source.event.sessionId,
            sessionEpoch: source.event.sessionEpoch,
            reason: "reader_overflow",
            missingEventRange: { start: String(next), end: String(next + 1) },
          },
        });
        next++;
        offset++;
      }
      batch.push({
        kind: "source",
        event: {
          ...source.event,
          eventSeq: String(next++),
          payload: {
            byteStart: String(offset),
            byteEnd: String(offset + bytes.length),
            bytesBase64: bytes.toString("base64"),
          },
        },
      });
      await page.evaluate(
        (items) => window.workbenchFixture.emitRaw(items),
        batch,
      );
      offset += bytes.length;
    },
    async firstCell() {
      const box = await rows.boundingBox();
      if (!box) throw new Error("Missing terminal rows");
      return { x: box.x + 3, y: box.y + 4 };
    },
  };
}

test("ANSI only forwards negotiated mouse reports from a focused and enabled terminal", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  await ansi.feed("\x1b[?1000;1006hREADY");
  await expect(ansi.rows).toContainText("READY");
  const clickFirstCell = async () => {
    const { x, y } = await ansi.firstCell();
    await page.mouse.click(x, y);
  };
  const sent = async () =>
    Buffer.concat(
      (await page.evaluate(() => window.workbenchFixture.sentBytes)).map(
        (chunk) => Buffer.from(chunk, "base64"),
      ),
    );
  await clickFirstCell();
  const keyboard = ansi.viewer.getByRole("switch", {
    name: "Send keyboard input",
  });
  await keyboard.click();
  await clickFirstCell();
  expect(await sent()).toHaveLength(0);

  const mouse = ansi.viewer.getByRole("switch", { name: "Send mouse reports" });
  await expect(mouse).not.toBeChecked();
  await mouse.click();
  await expect(ansi.input).toBeFocused();
  const { x, y } = await ansi.firstCell();
  await ansi.terminal.dispatchEvent("mousedown", {
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
  });
  await ansi.terminal.dispatchEvent("mouseup", {
    button: 0,
    buttons: 0,
    clientX: x,
    clientY: y,
  });
  await clickFirstCell();
  const sgr = Buffer.from("\x1b[<0;1;1M\x1b[<0;1;1m");
  await expect.poll(sent).toEqual(sgr);

  await ansi.input.press("Shift+Tab");
  await expect(keyboard).toBeFocused();
  await clickFirstCell();
  await expect(ansi.input).toBeFocused();
  await ansi.feed("\x1b[?1006l\x1b[5nLEGACY");
  await expect(ansi.rows).toContainText("LEGACY");
  await clickFirstCell();
  const legacy = Buffer.from([27, 91, 77, 32, 33, 33, 27, 91, 77, 35, 33, 33]);
  await expect.poll(sent).toEqual(Buffer.concat([sgr, legacy]));
  const selectModifier = process.platform === "darwin" ? "Alt" : "Shift";
  const selection = await ansi.firstCell();
  await page.keyboard.down(selectModifier);
  await page.mouse.move(selection.x, selection.y);
  await page.mouse.down();
  await page.mouse.move(selection.x + 28, selection.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(selectModifier);
  await expect(
    ansi.terminal.locator(".xterm-selection > div").first(),
  ).toBeVisible();
  expect(await sent()).toEqual(Buffer.concat([sgr, legacy]));
});

test("OSC 8 uses the host opener for explicit mouse and keyboard activation", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  const href = "https://example.invalid/manual";
  const osc = (uri: string, label: string) =>
    `\x1b]8;;${uri}\x07${label}\x1b]8;;\x07`;
  await ansi.feed(
    `${osc(href, "Manual")}\r\n${osc("file:///private.txt", "Local file")}\r\n${osc("https://user@example.invalid/secret", "Credentials")}`,
  );
  await expect(ansi.rows).toContainText("Credentials");
  const opened = () =>
    page.evaluate(() => window.workbenchFixture.openedExternalLinks);
  expect(await opened()).toEqual([]);
  const { x, y } = await ansi.firstCell();
  await page.mouse.move(x, y);
  await expect(ansi.terminal.locator(".xterm-screen")).toHaveClass(
    /xterm-cursor-pointer/,
  );
  await page.mouse.click(x, y);
  await expect.poll(opened).toEqual([href]);

  await ansi.viewer.getByText("Terminal links", { exact: true }).click();
  await expect(ansi.viewer.getByRole("link")).toHaveCount(1);
  const link = ansi.viewer.getByRole("link", { name: href });
  await link.evaluate((anchor: HTMLAnchorElement) => anchor.click());
  expect(await opened()).toEqual([href]);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect.poll(opened).toEqual([href, href]);
  await link.click({ button: "middle" });
  await expect.poll(opened).toEqual([href, href, href]);
  await ansi.feed("New continuous interval", true);
  await expect(ansi.rows).toContainText("New continuous interval");
  await expect(
    ansi.viewer.getByText("Terminal links", { exact: true }),
  ).toHaveCount(0);
});
