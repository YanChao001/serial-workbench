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

test("ANSI history jumps across retained lines and keeps receiving while frozen", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const ansi = await openAnsi(page);
  const history = ansi.viewer.locator(".workbench-ansi-history");
  const summary = history.locator("summary");
  await expect(summary).toContainText("Scrollback limit 3,000");
  await summary.click();
  const limit = history.getByRole("spinbutton", { name: "Scrollback limit" });
  const apply = history.getByRole("button", { name: "Apply limit" });
  await limit.fill("50001");
  await expect(apply).toBeDisabled();
  await limit.fill("12500");
  await apply.click();
  await expect(summary).toContainText("Scrollback limit 12,500");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.clientStateWrites.at(-1)?.preferences
            .ansiScrollbackLines,
      ),
    )
    .toBe(12_500);

  for (let start = 1; start <= 12_000; start += 1_000) {
    const text = Array.from(
      { length: 1_000 },
      (_, index) => `L${String(start + index).padStart(5, "0")}\r\n`,
    ).join("");
    await ansi.feed(text);
  }
  await expect(ansi.rows).toContainText("L12000");
  const line = history.getByRole("spinbutton", { name: "Retained line" });
  await line.fill("6001");
  await history.getByRole("button", { name: "Jump", exact: true }).click();
  await expect(ansi.rows).toContainText("L06001");
  await expect(history.getByText(/^Showing lines/)).toContainText("6,001");
  await history.getByRole("button", { name: "First retained line" }).click();
  await expect(ansi.rows).toContainText("L00001");
  await history.getByRole("button", { name: "Latest retained lines" }).click();
  await expect(ansi.rows).toContainText("L12000");

  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await receive.getByRole("button", { name: "Freeze", exact: true }).click();
  await ansi.feed("DURING-FREEZE\r\n");
  await expect(ansi.rows).toContainText("L12000");
  await expect(ansi.rows).not.toContainText("DURING-FREEZE");
  await receive.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(ansi.rows).toContainText("DURING-FREEZE");

  await limit.fill("10");
  await apply.click();
  await expect(summary).toContainText("Earlier lines unavailable");
  await history.getByRole("button", { name: "First retained line" }).click();
  await expect(ansi.rows).not.toContainText("L00001");
  await history.getByRole("button", { name: "Latest retained lines" }).click();
  await ansi.feed("\x1b[?1049hALTERNATE");
  await expect(ansi.rows).toContainText("ALTERNATE");
  await expect(history.getByText(/^Showing lines/)).toContainText(
    "Alternate screen",
  );
  await ansi.feed("\x1b[?1049l");
  await expect(history.getByText(/^Showing lines/)).not.toContainText(
    "Alternate screen",
  );
  await expect(ansi.rows).toContainText("DURING-FREEZE");
});

test("ANSI screen search highlights rendered results and leaves overwritten bytes searchable", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  await ansi.feed(
    `ERASE-ME\x1b[2K\r宽X42\r\nSecond X43\r\n${"a".repeat(260)}尾\r\n`,
  );
  await expect(ansi.rows).toContainText("尾");
  const search = ansi.viewer.locator(".workbench-ansi-search");
  await search.locator("summary").click();
  const input = search.getByRole("textbox", { name: "Search ANSI screen" });
  const submit = search.getByRole("button", { name: "Search ANSI screen" });
  const status = search.locator('[aria-live="polite"]');
  await input.fill("ERASE-ME");
  await submit.click();
  await expect(status).toContainText("No matches");

  await search.getByRole("switch", { name: "Regular expression" }).click();
  await input.fill("X42Second");
  await submit.click();
  await expect(status).toContainText("No matches");
  await input.fill("[");
  await submit.click();
  await expect(status).toContainText("Invalid expression");
  await input.fill("X[0-9]{2}");
  await input.press("Enter");
  await expect(status).toHaveText("1/2");
  const highlights = ansi.terminal.locator(".xterm-selection > div");
  await expect(highlights.first()).toBeVisible();
  await search.getByRole("button", { name: "Next match" }).click();
  await expect(status).toHaveText("2/2");
  await search.getByRole("button", { name: "Previous match" }).click();
  await expect(status).toHaveText("1/2");

  await input.fill("a{260}尾");
  await submit.click();
  await expect(status).toHaveText("1/1");
  await expect(highlights.first()).toBeVisible();
  await expect.poll(() => highlights.count()).toBeGreaterThan(1);
  await ansi.feed("\x1b[?1049hALTERNATE");
  await expect(status).toContainText("Screen changed");
  await expect(highlights).toHaveCount(0);
  await submit.click();
  await expect(status).toContainText("No matches");

  await search.locator("summary").click();
  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await receive
    .getByRole("button", { name: "Search bytes", exact: true })
    .click();
  const rawQuery = receive.getByRole("textbox", { name: "Search bytes" });
  await rawQuery.fill("ERASE-ME");
  await rawQuery.press("Enter");
  await expect(
    receive.getByRole("status").filter({ hasText: "1/1" }),
  ).toBeVisible();
});
