/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SharedSettings,
  TerminalTypography,
} from "@serial-workbench/contracts";
import { defaults } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

async function openAnsi(
  page: Page,
  theme?: "light" | "dark",
  typography?: TerminalTypography,
) {
  await seedWorkbenchFixture(page, {
    sidebarCollapsed: true,
    language: "en",
    theme,
    sharedSettings: typography
      ? {
          terminal: {
            ...(defaults.settings as SharedSettings).terminal,
            typography,
          },
        }
      : {},
  });
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

test("ANSI reports local window sizes only after explicit session consent", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  const keyboard = ansi.viewer.getByRole("switch", {
    name: "Send keyboard input",
  });
  const report = ansi.viewer.getByRole("switch", {
    name: "Send CSI window size",
  });
  const renderedRows = () => ansi.rows.locator(":scope > div").count();
  const sent = async () => {
    const chunks = await page.evaluate(() => window.workbenchFixture.sentBytes);
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    ).toString();
  };
  const reports = async () => (await sent()).split("\x1b[8;").slice(1);
  await expect(report).toHaveCount(0);
  await keyboard.click();
  await expect(report).not.toBeChecked();
  const originalRows = await renderedRows();
  await page.setViewportSize({ width: 950, height: 650 });
  await expect.poll(renderedRows).not.toBe(originalRows);
  await delay(200);
  expect(await sent()).toBe("");

  await report.click();
  await expect.poll(reports).toHaveLength(1);
  const [initial] = await reports();
  expect(initial).toMatch(/^\d+;\d+t$/);
  expect(Number(initial!.split(";")[0])).toBe(await renderedRows());

  await page.setViewportSize({ width: 1160, height: 760 });
  await expect.poll(reports).toHaveLength(2);
  const changed = (await reports())[1]!;
  expect(changed).toMatch(/^\d+;\d+t$/);
  expect(Number(changed.split(";")[0])).toBe(await renderedRows());
  expect(changed.split(";")[1]).not.toBe(initial!.split(";")[1]);

  await ansi.feed("\x1b[8;99;199tDEVICE");
  await expect(ansi.rows).toContainText("DEVICE");
  expect(await renderedRows()).not.toBe(99);
  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await receive.getByRole("button", { name: "Freeze", exact: true }).click();
  await page.setViewportSize({ width: 1030, height: 705 });
  await expect(report).toHaveCount(0);
  await delay(200);
  expect(await reports()).toHaveLength(2);
  await receive.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(keyboard).not.toBeChecked();
});

test("ANSI local echo keeps typed input separate from the device and screen export", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  const keyboard = ansi.viewer.getByRole("switch", {
    name: "Send keyboard input",
  });
  const localEcho = ansi.viewer.getByRole("switch", {
    name: "Local keyboard echo",
  });
  const transcript = ansi.viewer
    .getByRole("region", { name: "Local keyboard echo" })
    .locator("pre");
  const sent = async () => {
    const chunks = await page.evaluate(() => window.workbenchFixture.sentBytes);
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    ).toString();
  };
  await ansi.feed("READY>");
  await expect(ansi.rows).toContainText("READY>");
  await expect(localEcho).toHaveCount(0);
  await keyboard.click();
  await ansi.input.press("q");
  await expect(transcript).toHaveCount(0);

  await localEcho.click();
  await expect(ansi.input).toBeFocused();
  await page.keyboard.type("local-echo-X");
  await ansi.input.press("Backspace");
  await page.keyboard.type("9");
  await ansi.input.press("Enter");
  await page.keyboard.type("private-tail");
  await expect
    .poll(() => transcript.textContent())
    .toBe("local-echo-9\nprivate-tail");
  await expect.poll(sent).toBe("qlocal-echo-X\x7f9\rprivate-tail");
  await expect(ansi.rows).not.toContainText("local-echo-9");

  await ansi.feed("\r\nDEVICE: local-echo-9");
  await expect(ansi.rows).toContainText("DEVICE: local-echo-9");
  await expect(transcript).not.toContainText("DEVICE");
  await ansi.viewer
    .getByRole("button", { name: "Export ANSI screen with colors" })
    .click();
  const saved = () =>
    page.evaluate(
      () => window.workbenchFixture.savedTextExports.at(-1)?.content,
    );
  await expect.poll(saved).toContain("DEVICE: local-echo-9");
  expect(await saved()).not.toContain("private-tail");

  await localEcho.click();
  await expect(transcript).toHaveCount(0);
  await localEcho.click();
  await expect(transcript).toBeEmpty();
  await page.keyboard.type("cleared-on-freeze");
  await expect(transcript).toHaveText("cleared-on-freeze");
  await page
    .getByRole("region", { name: "Receive", exact: true })
    .getByRole("button", { name: "Freeze", exact: true })
    .click();
  await expect(transcript).toHaveCount(0);
  await expect(localEcho).toHaveCount(0);
});

test("ANSI inserts session shell settings and leaves execution to the terminal Enter key", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  const shell = ansi.viewer.locator(".workbench-ansi-shell");
  const sent = async () => {
    const chunks = await page.evaluate(() => window.workbenchFixture.sentBytes);
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    ).toString();
  };
  await expect(shell).toHaveCount(0);
  await ansi.viewer
    .getByRole("switch", { name: "Send keyboard input" })
    .click();
  await shell.locator("summary").click();
  const insert = shell.getByRole("button", { name: "Insert shell settings" });
  const term = shell.getByRole("textbox", { name: "TERM" });
  await term.fill("xterm;other");
  await expect(insert).toBeDisabled();
  await shell.getByRole("combobox", { name: "Color capability" }).click();
  await page.getByRole("option", { name: "24-bit true color" }).click();
  await term.fill("screen-256color");
  const rows = shell.getByRole("spinbutton", { name: "Rows" });
  const cols = shell.getByRole("spinbutton", { name: "Columns" });
  await rows.fill("37");
  await cols.fill("112");
  expect(await sent()).toBe("");
  await insert.click();

  const override =
    "export TERM=screen-256color COLORTERM=truecolor LINES=37 COLUMNS=112";
  await expect(shell.getByRole("status")).toContainText(override);
  await expect(ansi.input).toBeFocused();
  await expect.poll(sent).toBe(override);
  await ansi.input.press("Enter");
  await expect.poll(sent).toBe(override + "\r");

  await shell.getByRole("combobox", { name: "Color capability" }).click();
  await page.getByRole("option", { name: "Monochrome" }).click();
  await rows.fill("");
  await cols.fill("");
  await insert.click();
  const actual = (await shell.locator("code").textContent()) ?? "";
  expect(actual).toContain(
    `export TERM=vt100 COLORTERM= LINES=${await ansi.rows.locator(":scope > div").count()} COLUMNS=`,
  );
  await expect.poll(sent).toBe(override + "\r" + actual);

  await page
    .getByRole("region", { name: "Receive", exact: true })
    .getByRole("button", { name: "Freeze", exact: true })
    .click();
  await expect(shell).toHaveCount(0);
});

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

test("incoming ANSI control requests leave the clipboard, files and serial writes under user control", async ({
  page,
}) => {
  const ansi = await openAnsi(page);
  await ansi.viewer
    .getByRole("switch", { name: "Send keyboard input" })
    .click();
  await page.evaluate(() => {
    const note = () =>
      window.workbenchFixture.copiedLanInfo.push("browser clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => {
          note();
          return [];
        },
        readText: async () => {
          note();
          return "";
        },
        write: async () => {
          note();
        },
        writeText: async () => {
          note();
        },
      },
    });
  });
  const clipboardSample = Buffer.from("fixture clipboard").toString("base64");
  const label = "Visible terminal text";
  await ansi.feed("\x1b]52;c;");
  await ansi.feed(clipboardSample + "\x07");
  await ansi.feed("\x1b]52;c;?\x1b\\");
  await ansi.feed("\x1b]1337;File=inline=0:Zml4dHVyZQ==\x07");
  await ansi.feed("\x1b[32m" + label + "\x1b[0m");
  await expect(ansi.rows.locator(".xterm-fg-2")).toHaveText(label);
  const effects = await page.evaluate(() => ({
    clipboard: window.workbenchFixture.copiedLanInfo,
    exports: window.workbenchFixture.savedTextExports,
    links: window.workbenchFixture.openedExternalLinks,
    writes: window.workbenchFixture.sentBytes,
  }));
  expect(effects).toEqual({
    clipboard: [],
    exports: [],
    links: [],
    writes: [],
  });

  await ansi.viewer
    .getByRole("button", { name: "Export ANSI screen with colors" })
    .click();
  const content = await page.evaluate(
    () => window.workbenchFixture.savedTextExports.at(-1)?.content,
  );
  expect(content).toContain(label);
  expect(content).toContain("\x1b[0;38;2;");
  expect(content).not.toContain("\x1b]");
  expect(content).not.toContain(clipboardSample);
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

for (const theme of ["light", "dark"] as const) {
  test(`ANSI ${theme} screen and export agree on basic, indexed and RGB colors`, async ({
    page,
  }) => {
    const ansi = await openAnsi(page, theme);
    await ansi.feed(
      "\x1b[31mBASIC\x1b[0m \x1b[38;5;196;48;5;21mINDEX\x1b[0m " +
        "\x1b[38;2;18;52;86;48;2;28;66;100mTRUE\x1b[0m " +
        "\x1b]8;;https://example.invalid/private\x07LINK\x1b]8;;\x07",
    );
    await expect(ansi.rows).toContainText("LINK");
    const basic = theme === "light" ? [159, 32, 43] : [250, 120, 124];
    const background = theme === "light" ? [255, 255, 255] : [23, 30, 44];
    await expect(ansi.rows.getByText("BASIC", { exact: true })).toHaveCSS(
      "color",
      `rgb(${basic.join(", ")})`,
    );
    const indexed = ansi.rows.getByText("INDEX", { exact: true });
    await expect(indexed).toHaveCSS("color", "rgb(255, 0, 0)");
    await expect(indexed).toHaveCSS("background-color", "rgb(0, 0, 255)");
    const trueColor = ansi.rows.getByText("TRUE", { exact: true });
    await expect(trueColor).toHaveCSS("color", "rgb(18, 52, 86)");
    await expect(trueColor).toHaveCSS("background-color", "rgb(28, 66, 100)");

    await ansi.viewer
      .getByRole("button", { name: "Export ANSI screen with colors" })
      .click();
    const saved = () =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.at(-1));
    await expect
      .poll(async () => (await saved())?.name)
      .toBe("serial-workbench-ansi-screen.txt");
    const content = (await saved())?.content ?? "";
    expect(content).toContain(
      `\x1b[0;38;2;${basic.join(";")};48;2;${background.join(";")}mBASIC`,
    );
    expect(content).toContain("\x1b[0;38;2;255;0;0;48;2;0;0;255mINDEX");
    expect(content).toContain("\x1b[0;38;2;18;52;86;48;2;28;66;100mTRUE");
    expect(content).toContain("LINK");
    expect(content).not.toContain("https://example.invalid/private");
    expect(content.endsWith("\x1b[0m")).toBe(true);
  });
}

for (const ligatures of [false, true]) {
  test(`ANSI maintains cell selection with programming ligatures ${ligatures ? "on" : "off"}`, async ({
    page,
  }) => {
    const fontSource = readFileSync(
      new URL("./fixtures/ansi-ligature.ttf", import.meta.url),
      "base64",
    );
    await page.addInitScript((source) => {
      const font = new FontFace(
        "SWB Ligature Fixture",
        `url(data:font/ttf;base64,${source})`,
      );
      document.fonts.add(font);
      void font.load();
    }, fontSource);
    const ansi = await openAnsi(page, "light", {
      fontFamily: '"SWB Ligature Fixture", monospace',
      fontSize: 20,
      lineHeightPercent: 175,
      ligatures,
    });
    await page.evaluate(() =>
      document.fonts.load('20px "SWB Ligature Fixture"'),
    );
    await ansi.feed("A=>B\r\nW");
    const first = ansi.rows.locator(":scope > div").first();
    await expect(first).toHaveText("A=>B");
    await expect(ansi.viewer).toHaveCSS(
      "font-variant-ligatures",
      ligatures ? "normal" : "none",
    );
    // The fixture font gives two ordinary cells 1000 units and the calt glyph 800.
    const glyphWidth = await first.evaluate((row) => {
      const sample = document.createElement("span");
      const style = getComputedStyle(row);
      sample.style.fontFamily = style.fontFamily;
      sample.style.fontSize = style.fontSize;
      sample.style.fontFeatureSettings = style.fontFeatureSettings;
      sample.style.fontVariantLigatures = style.fontVariantLigatures;
      sample.style.position = "absolute";
      sample.textContent = "=>";
      document.body.append(sample);
      const width = sample.getBoundingClientRect().width;
      sample.remove();
      return width;
    });
    expect(glyphWidth).toBe(ligatures ? 16 : 20);
    if (ligatures)
      await expect(first.getByText("=>", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 1100, height: 750 });
    const box = await first.boundingBox();
    if (!box) throw new Error("Missing first ANSI row");
    const cellWidth = 10;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2.2 * cellWidth, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 2.8 * cellWidth, y, { steps: 3 });
    await page.mouse.up();
    const copied = await ansi.terminal.evaluate((terminal) => {
      const clipboardData = new DataTransfer();
      terminal.dispatchEvent(new ClipboardEvent("copy", { clipboardData }));
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe(">");
  });
}
