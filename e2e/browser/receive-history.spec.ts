/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

async function choose(page: Page, name: string, value: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

async function chooseFilter(page: Page, label: string, option: string) {
  const filters = page.getByRole("button", { name: "Record filters" });
  const panel = page.getByRole("dialog", { name: "Record filters" });
  await filters.click();
  await expect(panel).toBeVisible();
  await choose(page, label, option);
  await panel
    .getByRole("combobox", { name: label, exact: true })
    .press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(filters).toBeFocused();
}

function packets(
  start: number,
  count: number,
  bytesPerPacket = 12,
  byteStart = (start - 1) * bytesPerPacket,
): unknown[] {
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  return Array.from({ length: count }, (_, offset) => {
    const sequence = start + offset;
    return {
      kind: "source",
      event: {
        ...source.event,
        kind: "rx",
        eventSeq: String(sequence + 10),
        time: {
          ...source.event.time,
          sourceMonoNs: String(sequence * 200_000_000),
        },
        payload: {
          bytesBase64: Buffer.from(
            `packet-${String(sequence).padStart(4, "0")}\n`.padEnd(
              bytesPerPacket,
              "0",
            ),
          ).toString("base64"),
          byteStart: String(byteStart + offset * bytesPerPacket),
          byteEnd: String(byteStart + (offset + 1) * bytesPerPacket),
        },
      },
    };
  });
}

test("applies ordered text highlights and keeps receiving when a rule is invalid", async ({
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
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  const display = terminal.getByRole("button", { name: "Display options" });
  const editor = page.getByRole("dialog", { name: "Text highlight rules" });
  const openEditor = async () => {
    await display.click();
    await page.getByRole("button", { name: "Text highlight rules" }).click();
    await expect(editor).toBeVisible();
  };
  const rule = (number: number) =>
    editor.getByRole("group", { name: "Rule " + number, exact: true });
  const add = editor.getByRole("button", { name: "Add rule", exact: true });
  const rx = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (rx?.kind !== "source") throw new Error("Missing RX");
  const addText = async (text: string, start: number, time: string) => {
    await page.evaluate((item) => window.workbenchFixture.emitRaw([item]), {
      kind: "source",
      event: {
        ...rx.event,
        eventSeq: String(start + 30),
        time: { ...rx.event.time, sourceMonoNs: time },
        payload: {
          bytesBase64: Buffer.from(text).toString("base64"),
          byteStart: String(start),
          byteEnd: String(start + Buffer.byteLength(text)),
        },
      },
    });
  };

  await addText("ERROR code=42", 0, "1");
  await openEditor();
  await add.click();
  await rule(1).getByRole("textbox", { name: "Pattern" }).fill("ERR");
  await rule(1).getByRole("switch", { name: "Text color" }).click();
  await rule(1)
    .getByLabel("Text color", { exact: true })
    .and(rule(1).locator('input[type="color"]'))
    .fill("#b50000");

  await add.click();
  await rule(2).getByRole("combobox", { name: "Match type" }).click();
  await page.getByRole("option", { name: "Regular expression" }).click();
  await rule(2).getByRole("textbox", { name: "Pattern" }).fill("ERR\\w+|\\d+");
  await rule(2).getByRole("switch", { name: "Background color" }).click();
  await rule(2).getByRole("switch", { name: "Bold" }).click();
  await page.keyboard.press("Escape");
  await expect(display).toBeFocused();

  const highlights = log.locator("[data-stream-highlight]");
  await expect(highlights).toHaveText(["ERR", "OR", "42"]);
  await expect(highlights.nth(0)).toHaveCSS("color", "rgb(181, 0, 0)");
  await expect(highlights.nth(0)).toHaveCSS("font-weight", "700");
  await expect(highlights.nth(1)).toHaveCSS(
    "background-color",
    "rgb(255, 235, 153)",
  );

  await openEditor();
  await rule(2).getByRole("button", { name: "Move rule up" }).click();
  await page.keyboard.press("Escape");
  await expect(highlights).toHaveText(["ERROR", "42"]);

  await openEditor();
  await rule(1).getByRole("switch", { name: "Enabled" }).click();
  await add.click();
  await rule(3).getByRole("combobox", { name: "Match type" }).click();
  await page.getByRole("option", { name: "Regular expression" }).click();
  await rule(3).getByRole("textbox", { name: "Pattern" }).fill("[");
  await expect(rule(3).getByRole("status")).toHaveText(
    "Invalid regular expression",
  );
  await page.keyboard.press("Escape");
  await expect(highlights).toHaveText(["ERR"]);

  await addText("ERR second", 13, "200000001");
  await expect(highlights).toHaveText(["ERR", "ERR"]);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  await expect(highlights).toHaveCount(0);
  await expect(log.locator("[data-hex-source]").first()).toHaveText(
    "45 52 52 4F 52 20 63 6F 64 65 3D 34 32",
  );

  await terminal.getByRole("radio", { name: "Text", exact: true }).click();
  await addText("A".repeat(65536) + "ERR tail", 23, "400000001");
  const detail = log.locator(".workbench-long-record");
  const pageHighlights = detail.locator("[data-stream-highlight]");
  await expect(detail.locator("summary")).toContainText("65544 B");
  await expect(pageHighlights).toHaveCount(0);
  await detail.locator("summary").click();
  await expect(detail.getByRole("status")).toContainText("1/2");
  await expect(pageHighlights).toHaveCount(0);
  await detail.getByRole("button", { name: "Next record page" }).click();
  await expect(pageHighlights).toHaveText("ERR");
});

test("sets the live idle gap without reframing existing packets or restarting the reader", async ({
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
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  const flows = log.locator('[data-direction="rx"]');
  const emit = async (start: number, sourceNs: string[]) => {
    const fixture = workbenchStreamItems().find(
      (item) => item.kind === "source" && item.event.kind === "rx",
    );
    if (fixture?.kind !== "source") throw new Error("Missing RX");
    const items = sourceNs.map((sourceMonoNs, index) => {
      const offset = start + index;
      return {
        kind: "source",
        event: {
          ...fixture.event,
          eventSeq: String(offset + 20),
          time: { ...fixture.event.time, sourceMonoNs },
          payload: {
            bytesBase64: Buffer.from(String.fromCharCode(65 + offset)).toString(
              "base64",
            ),
            byteStart: String(offset),
            byteEnd: String(offset + 1),
          },
        },
      };
    });
    await page.evaluate(
      (events) => window.workbenchFixture.emitRaw(events),
      items,
    );
  };
  await emit(0, ["0", "50000000"]);
  await expect(flows).toHaveCount(1);
  await expect(flows.nth(0).locator(".workbench-payload")).toHaveText("AB");
  await expect(flows.nth(0).locator("time")).toHaveAttribute(
    "title",
    "Receive idle gap 100 ms · Host read · 1000 ns",
  );
  await expect(
    flows.nth(0).locator('.workbench-stream-meta [title="2 B"]'),
  ).toBeVisible();

  await terminal.getByRole("button", { name: "Display options" }).click();
  const threshold = page.getByRole("combobox", { name: "Receive idle gap" });
  await expect(threshold).toHaveText("100 ms");
  await expect(page.getByText(/USB buffering can hide gaps/)).toBeVisible();
  await choose(page, "Receive idle gap", "10 ms");
  await expect(threshold).toHaveText("10 ms");
  await threshold.press("Escape");

  await emit(2, ["51000000", "61000000", "71000001"]);
  await expect(flows).toHaveCount(3);
  await expect(flows.nth(0).locator(".workbench-payload")).toHaveText("AB");
  await expect(flows.nth(1).locator(".workbench-payload")).toHaveText("CD");
  await expect(flows.nth(2).locator(".workbench-payload")).toHaveText("E");
  await expect(flows.nth(1).locator("time")).toHaveAttribute(
    "title",
    "Receive idle gap 10 ms · Host read · 1000 ns",
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("folds long receive messages until requested and shows only one bounded page", async ({
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
  const fixture = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (fixture?.kind !== "source") throw new Error("Missing RX fixture");
  const offset = 9_007_199_254_741_067n;
  const first = Buffer.alloc(65536, 65);
  first[first.length - 1] = 0xe4;
  const tail = Buffer.concat([
    Buffer.from([0xb8, 0xad]),
    Buffer.from("LONG-TAIL"),
  ]);
  const total = first.length + tail.length;
  const events = [first, tail].map((bytes, index) => {
    const start = index === 0 ? 0 : first.length;
    return {
      kind: "source",
      event: {
        ...fixture.event,
        eventSeq: String(Number(fixture.event.eventSeq) + index),
        time: {
          ...fixture.event.time,
          sourceMonoNs: String(index * 200_000_000 + 1),
        },
        payload: {
          bytesBase64: bytes.toString("base64"),
          byteStart: String(offset + BigInt(start)),
          byteEnd: String(offset + BigInt(start + bytes.length)),
          message: {
            messageId: "long-capture-record",
            messageType: "fixture",
            fragmentOffset: String(start),
            messageLength: String(total + 5),
          },
        },
      },
    };
  });
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    events,
  );
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  const detail = log.locator(".workbench-long-record");
  await expect(detail).toHaveCount(1);
  const summary = detail.locator("summary");
  await expect(summary).toContainText(total + "/" + (total + 5) + " B");
  await expect(summary).toContainText("fixture");
  await expect(summary).toContainText("Partial data");
  await expect(detail.locator("pre")).toHaveCount(0);

  await summary.press("Enter");
  await expect(detail.getByRole("status")).toContainText("1/2");
  expect((await detail.locator("pre").textContent())?.length).toBe(65535);
  await detail.getByRole("button", { name: "Next record page" }).click();
  await expect(detail.getByRole("status")).toContainText(
    String(offset + 65536n),
  );
  await expect(detail.getByRole("status")).toContainText("2/2");
  await expect(detail.locator("pre")).toHaveText("中LONG-TAIL");
  await expect(
    detail.getByRole("button", { name: "Next record page" }),
  ).toBeDisabled();

  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  const hex = detail.locator("pre");
  await expect(hex).toContainText("B8 AD 4C 4F 4E 47");
  const selectStarter = () =>
    hex.evaluate((entry) => {
      const node = entry.firstChild;
      if (!node) throw new Error("Missing long record HEX page");
      document.getSelection()?.setBaseAndExtent(node, 0, node, 5);
    });
  await selectStarter();
  await terminal.getByRole("button", { name: "Inspect number" }).click();
  const inspector = page.getByRole("dialog", { name: "Inspect number" });
  await expect(inspector).toContainText("B8AD");
  await expect(inspector).toContainText(
    "Byte offset " + String(offset + 65536n),
  );
  await page.keyboard.press("Escape");

  await selectStarter();
  await terminal.getByRole("button", { name: "Copy byte selection" }).click();
  const copy = page.getByRole("dialog", { name: "Copy byte selection" });
  await choose(page, "Copy format", "HEX");
  await copy.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.copiedLanInfo.at(-1)),
    )
    .toBe("B8 AD");
  await page.keyboard.press("Escape");

  await summary.click();
  await expect(detail.locator("pre")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("numbers display records and restores an exact copied event through filtering and eviction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 530 });
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const gap = {
    kind: "reader_gap",
    gap: {
      hostId: source.event.hostId,
      instanceEpoch: source.event.instanceEpoch,
      sessionId: source.event.sessionId,
      sessionEpoch: source.event.sessionEpoch,
      reason: "reader_overflow",
      missingEventRange: { start: "1", end: "10" },
    },
  };
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    [gap, ...packets(1, 36)],
  );
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(36);
  const trigger = terminal.getByRole("button", { name: "Record location" });
  const panel = page.getByRole("dialog", { name: "Record location" });
  const target = log.locator('[data-location-target="true"]');
  await expect(log.locator(".workbench-stream-location")).toHaveCount(0);
  await trigger.click();
  await panel.getByRole("switch", { name: "Show record numbers" }).click();
  const jump = async (mode: string, value: string) => {
    await choose(page, "Locate by", mode);
    await panel.getByRole("textbox", { name: mode, exact: true }).fill(value);
    await panel.getByRole("button", { name: "Jump", exact: true }).click();
  };

  await jump("Packet", "1");
  await expect(target).toHaveAttribute("data-offset", "0");
  await expect(target.locator(".workbench-stream-location")).toContainText(
    "Packet 1",
  );
  await expect(target.locator(".workbench-stream-location")).toContainText(
    "Event 11",
  );
  await expect(panel.getByRole("status")).toContainText("Located line 2");
  await expect(target).toBeInViewport();

  await jump("Event", "32");
  await expect(target).toHaveAttribute("data-offset", "252");
  await expect(target).toBeInViewport();
  await panel.getByRole("button", { name: "Copy event location" }).click();
  const copied = () =>
    page.evaluate(() => window.workbenchFixture.copiedLanInfo.at(-1));
  const expected =
    "SWB1 " +
    JSON.stringify([
      source.event.hostId,
      source.event.instanceEpoch,
      source.event.sessionId,
      source.event.sessionEpoch,
      "32",
      "252",
    ]);
  await expect.poll(copied).toBe(expected);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await terminal.getByRole("button", { name: "Search bytes" }).click();
  await chooseFilter(page, "Direction", "TX");
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(0);
  await trigger.click();
  await jump("Copied location", expected);
  await expect(target).toHaveAttribute("data-offset", "252");
  await expect(target).toBeInViewport();
  await expect(panel.getByRole("status")).toContainText("Event 32");
  await jump("Line", "2");
  await expect(target).toHaveAttribute("data-offset", "0");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await terminal
    .getByRole("button", { name: en["workbench.tools.clearView"], exact: true })
    .click();
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(0);
  await trigger.click();
  await jump("Copied location", expected);
  await expect(panel.getByRole("status")).toHaveText(
    "This record is unavailable in the current history.",
  );
  await expect(target).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("filters regex matches across receive records and isolates transmit search and view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 550 });
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const fixtures = workbenchStreamItems();
  const rx = fixtures.find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  const tx = fixtures.find(
    (item) => item.kind === "source" && item.event.kind === "tx",
  );
  if (rx?.kind !== "source" || tx?.kind !== "source" || tx.event.kind !== "tx")
    throw new Error("Missing direction fixtures");
  const rows = [
    { input: "prefix HIT-", byteStart: 0, kind: "rx" },
    { input: "HIT-TX", byteStart: 0, kind: "tx" },
    { input: "END", byteStart: 11, kind: "rx" },
    { input: "quiet-rx", byteStart: 14, kind: "rx" },
    { input: "quiet-tx", byteStart: 6, kind: "tx" },
  ].map(({ input, kind, byteStart }, index) => {
    const event = kind === "rx" ? rx.event : tx.event;
    const start = String(byteStart);
    const end = String(byteStart + Buffer.byteLength(input));
    return {
      kind: "source",
      event: {
        ...event,
        eventSeq: String(30 + index),
        time: {
          ...event.time,
          sourceMonoNs: String((index + 1) * 1_000_000_000),
        },
        payload: {
          ...(kind === "tx" ? tx.event.payload : {}),
          bytesBase64: Buffer.from(input).toString("base64"),
          byteStart: start,
          byteEnd: end,
          ...(kind === "tx" ? { acceptedRanges: [{ start, end }] } : {}),
        },
      },
    };
  });
  await page.evaluate((items) => window.workbenchFixture.emitRaw(items), rows);

  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  const input = terminal.getByRole("textbox", { name: "Search bytes" });
  const search = terminal.getByRole("button", { name: "Search bytes" });
  const result = terminal
    .locator(".workbench-stream-search")
    .getByRole("status");
  const span = (direction: string, offset: number) =>
    log.locator(
      '[data-direction="' + direction + '"][data-offset="' + offset + '"]',
    );
  await expect(span("rx", 0)).toContainText("prefix HIT-");
  await expect(span("rx", 11)).toContainText("END");
  await expect(span("tx", 0)).toContainText("HIT-TX");
  await search.click();
  await chooseFilter(page, "Direction", "TX");
  await expect(span("rx", 0)).toHaveCount(0);
  await expect(span("tx", 6)).toContainText("quiet-tx");
  await expect(
    terminal.getByRole("group", { name: en["workbench.displayedRxBytes"] }),
  ).toContainText("0 B");
  await chooseFilter(page, "Direction", "Both directions");

  await terminal
    .getByRole("button", { name: en["workbench.searchRegex"] })
    .click();
  await input.fill("HIT-(END|TX)");
  await expect(result).toContainText("1/2");
  await chooseFilter(page, "Match visibility", "Matching records only");
  await expect(span("rx", 0)).toContainText("prefix HIT-");
  await expect(span("rx", 11)).toContainText("END");
  await expect(span("tx", 0)).toContainText("HIT-TX");
  await expect(span("rx", 14)).toHaveCount(0);
  await expect(span("tx", 6)).toHaveCount(0);
  await expect(
    terminal.getByRole("group", { name: en["workbench.displayedRxBytes"] }),
  ).toContainText("14 B");
  await expect(
    terminal.getByRole("group", { name: en["workbench.displayedTxBytes"] }),
  ).toContainText("6 B");

  await chooseFilter(page, "Direction", "TX");
  await expect(result).toContainText("1/1");
  await expect(span("tx", 0)).toContainText("HIT-TX");
  await expect(span("rx", 11)).toHaveCount(0);
  await chooseFilter(page, "Match visibility", "Hide matching records");
  await expect(span("tx", 0)).toHaveCount(0);
  await expect(span("tx", 6)).toContainText("quiet-tx");

  await chooseFilter(page, "Direction", "Both directions");
  await expect(result).toContainText("1/2");
  await expect(span("rx", 0)).toHaveCount(0);
  await expect(span("rx", 11)).toHaveCount(0);
  await expect(span("rx", 14)).toContainText("quiet-rx");
  await input.fill("[");
  await expect(result).toHaveText(en["workbench.searchInvalid"]);
  await expect(span("rx", 0)).toContainText("prefix HIT-");
  await expect(span("tx", 0)).toContainText("HIT-TX");
  await input.press("Escape");
  await expect(search).toBeFocused();
  await expect(
    log.locator('[data-direction="rx"], [data-direction="tx"]'),
  ).toHaveCount(5);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("copies six formats from one HEX selection with explicit decoding and timestamp source", async ({
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
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const offset = 9_007_199_254_741_021n;
  const events = [
    {
      bytes: "ff41e4",
      byteStart: offset,
      byteEnd: offset + 3n,
      mono: "1000000000",
      sourceTime: "2026-11-24T01:00:01.001Z",
      received: "2026-11-24T01:00:02.002Z",
    },
    {
      bytes: "b8ad4200",
      byteStart: offset + 3n,
      byteEnd: offset + 7n,
      mono: "3000000000",
      sourceTime: undefined,
      received: "2026-11-24T01:00:03.003Z",
    },
  ].map(({ bytes, byteStart, byteEnd, mono, sourceTime, received }, index) => ({
    kind: "source",
    event: {
      ...source.event,
      eventSeq: String(Number(source.event.eventSeq) + index),
      time: {
        ...source.event.time,
        sourceMonoNs: mono,
        sourceWallTime: sourceTime,
        receivedWallTime: received,
      },
      payload: {
        byteStart: byteStart.toString(),
        byteEnd: byteEnd.toString(),
        bytesBase64: Buffer.from(bytes, "hex").toString("base64"),
      },
    },
  }));
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    events,
  );
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  const trigger = terminal.getByRole("button", { name: "Copy byte selection" });
  const panel = page.getByRole("dialog", { name: "Copy byte selection" });
  await trigger.click();
  await expect(panel).toContainText("Up to 64 KiB");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const hex = terminal.getByRole("log").locator("[data-hex-source]");
  await expect(hex).toHaveCount(2);
  await hex.evaluateAll(([first, last]) => {
    const start = first?.firstChild;
    const end = last?.firstChild;
    if (!start || !end) throw new Error("Missing HEX payload");
    document.getSelection()?.setBaseAndExtent(start, 3, end, 8);
  });
  await trigger.click();
  await expect(panel).toContainText("RX · 5 B");
  const copy = async (expected: string) => {
    await panel.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Copied to clipboard");
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.copiedLanInfo.at(-1)),
      )
      .toBe(expected);
  };
  await choose(page, "Decoding", "UTF-8");
  await copy("A中B");
  await choose(page, "Decoding", "Latin-1");
  await copy("A\u00E4\u00B8\u00ADB");
  await choose(page, "Decoding", "UTF-8");
  await choose(page, "Copy format", "HEX");
  await copy("41 E4 B8 AD 42");
  await choose(page, "Copy format", "Base64");
  await copy("QeS4rUI=");
  await choose(page, "Copy format", "Python bytes");
  await copy('b"\\x41\\xE4\\xB8\\xAD\\x42"');
  await choose(page, "Copy format", "C array");
  await copy(
    "const unsigned char data[] = {\n  0x41, 0xE4, 0xB8, 0xAD, 0x42,\n};",
  );

  await choose(page, "Copy format", "Text with timestamps");
  const rest =
    "\tRX\t" +
    (offset + 1n).toString() +
    '\t"A"\n' +
    "2026-11-24T01:00:03.003Z\tRX\t" +
    (offset + 3n).toString() +
    '\t"中B"';
  await copy("2026-11-24T01:00:01.001Z" + rest);
  await choose(page, "Timestamp", "Received time");
  await copy("2026-11-24T01:00:02.002Z" + rest);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("HEX numeric inspector interprets selected raw bytes with explicit width and byte order", async ({
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
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const start = 9_007_199_254_741_039n;
  await page.evaluate((item) => window.workbenchFixture.emitRaw([item]), {
    kind: "source",
    event: {
      ...source.event,
      payload: {
        byteStart: start.toString(),
        byteEnd: (start + 8n).toString(),
        bytesBase64: Buffer.from("80000000ffffffff", "hex").toString("base64"),
      },
    },
  });
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const inspect = terminal.getByRole("button", { name: "Inspect number" });
  await expect(inspect).toHaveCount(0);
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Inspect number" });
  await inspect.click();
  await expect(panel).toContainText("Select 1–8 contiguous bytes");
  await page.keyboard.press("Escape");
  await expect(inspect).toBeFocused();

  await terminal.getByRole("button", { name: "Display options" }).click();
  const ascii = page.getByRole("switch", { name: "Show ASCII column" });
  await ascii.click();
  await ascii.press("Escape");
  const hex = terminal.getByRole("log").locator("[data-hex-source]");
  await expect(hex).toContainText("80 00 00 00 FF FF FF FF");
  await hex.evaluate((entry) => {
    const node = entry.firstChild;
    if (!node || !node.textContent?.endsWith("........"))
      throw new Error("Missing ASCII column");
    const end = node.textContent.length;
    document.getSelection()?.setBaseAndExtent(node, end - 8, node, end);
  });
  await inspect.click();
  const value = (name: string) =>
    panel
      .locator("dt")
      .filter({ hasText: new RegExp("^" + name + "$") })
      .locator("xpath=following-sibling::dd[1]");
  await expect(value("Source bytes")).toHaveText("80 00 00 00 FF FF FF FF");
  await expect(panel).toContainText("Byte offset " + start.toString());
  await expect(value("HEX")).toHaveText("80000000FFFFFFFF");

  await choose(page, "Width (bits)", "32");
  await expect(value("Source bytes")).toHaveText("80 00 00 00");
  await expect(value("Signed DEC")).toHaveText("-2147483648");
  await expect(value("Unsigned DEC")).toHaveText("2147483648");
  await expect(value("Float 32")).toHaveText("-0");
  await expect(value("BIN")).toHaveText("1" + "0".repeat(31));
  await expect(value("OCT")).toHaveText("20000000000");
  await choose(page, "Byte order", "Low byte first");
  await expect(value("HEX")).toHaveText("00000080");
  await expect(value("Signed DEC")).toHaveText("128");
  await expect(value("Source bytes")).toHaveText("80 00 00 00");
  await page.keyboard.press("Escape");
  await expect(inspect).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("HEX formatting restores a cross-line byte selection across case, grouping and ASCII changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 460 });
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);

  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  const offset = "9007199254741018";
  const bytes = Buffer.from("415a207e00ff0a6132427f21", "hex");
  await page.evaluate((item) => window.workbenchFixture.emitRaw([item]), {
    kind: "source",
    event: {
      ...source.event,
      payload: {
        byteStart: offset,
        byteEnd: (BigInt(offset) + BigInt(bytes.length)).toString(),
        bytesBase64: bytes.toString("base64"),
      },
    },
  });
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  const payload = terminal
    .getByRole("log")
    .locator('[data-offset="' + offset + '"] [data-hex-source]');
  await expect(payload).toHaveText("41 5A 20 7E 00 FF 0A 61 32 42 7F 21");
  const select = async (start: number, end: number) =>
    payload.evaluate(
      (element, range) => {
        if (!element.firstChild) throw new Error("Missing HEX text node");
        element.ownerDocument
          .getSelection()
          ?.setBaseAndExtent(
            element.firstChild,
            range.start,
            element.firstChild,
            range.end,
          );
      },
      { start, end },
    );
  const selection = () =>
    page.evaluate(() => window.getSelection()?.toString());

  await select(18, 26);
  await expect.poll(selection).toBe("0A 61 32");
  const options = terminal.getByRole("button", { name: "Display options" });
  await options.click();
  const menu = page.getByRole("dialog", { name: "Display options" });
  await expect(menu).toBeVisible();
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight &&
          element.scrollHeight > element.clientHeight
        );
      }),
    )
    .toBe(true);
  await choose(page, "HEX bytes per line", "8");
  await choose(page, "HEX bytes per group", "4");
  await page.getByRole("switch", { name: "Lowercase HEX" }).click();
  await page.getByRole("switch", { name: "Show HEX addresses" }).click();
  const ascii = page.getByRole("switch", { name: "Show ASCII column" });
  await ascii.click();
  await ascii.press("Escape");
  await expect(options).toBeFocused();
  const displayed =
    "002000000000001a  415a207e 00ff0a61  AZ ~...a\n0020000000000022  32427f21" +
    " ".repeat(11) +
    "2B.!";
  await expect.poll(() => payload.textContent()).toBe(displayed);
  await expect.poll(selection).toBe("0a61  AZ ~...a\n0020000000000022  32");

  await select(displayed.lastIndexOf("2B.!") + 1, displayed.indexOf("AZ") + 6);
  await options.click();
  await ascii.click();
  await ascii.press("Escape");
  await expect.poll(selection).toBe("0a61\n0020000000000022  32");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selected = window.getSelection();
        return Boolean(
          selected && selected.anchorOffset > selected.focusOffset,
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
});

test("receive text and HEX line layout preserve the raw bytes and their offset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const source = "packet-0001\n".padEnd(243, "0");
  const transmit = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "tx",
  );
  if (!transmit) throw new Error("Missing TX fixture");
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    [transmit, ...packets(1, 1, 243)],
  );

  const terminal = page.getByRole("region", {
    name: en["workbench.terminal"],
    exact: true,
  });
  const log = terminal.getByRole("log");
  const row = log.locator('[data-direction="rx"][data-offset="0"]');
  const body = row.locator(".workbench-payload");
  await expect(body).toHaveCSS("white-space", "pre-wrap");
  const options = terminal.getByRole("button", {
    name: "Display options",
    exact: true,
  });
  await options.click();
  const wrap = page.getByRole("switch", { name: "Wrap received text" });
  await expect(wrap).toBeChecked();
  await wrap.click();
  await expect(wrap).not.toBeChecked();
  await wrap.press("Escape");
  await expect(options).toBeFocused();
  await expect(body).toHaveCSS("white-space", "pre");
  expect(await body.textContent()).toBe(source);
  expect(
    await body.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeGreaterThan(0);

  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  await options.click();
  await choose(page, "HEX bytes per line", "8");
  const hex = row.locator('[data-hex-grouped="true"]');
  await expect(hex).toHaveCSS("white-space", "pre");
  const lines = (await hex.textContent())?.split("\n") ?? [];
  expect(lines.map((line) => line.split(" ").length)).toEqual([
    ...Array<number>(30).fill(8),
    3,
  ]);
  expect(lines.join(" ").replaceAll(" ", "").toLowerCase()).toBe(
    Buffer.from(source).toString("hex"),
  );
  const tx = log.locator('[data-direction="tx"]');
  const txBody = tx.locator('[data-hex-grouped="true"]');
  await expect(txBody).toBeVisible();
  await page.getByRole("switch", { name: "Show outgoing bytes" }).click();
  await expect(txBody).toBeHidden();
  await expect(hex).toBeVisible();
  await expect(
    tx.getByRole("button", { name: en["workbench.receipt"] }),
  ).toBeVisible();
});

test("small upward scrolling keeps the latest button available throughout history review", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    packets(1, 40),
  );
  const log = page.getByRole("log");
  await expect(log).toContainText("packet-0040");
  await expect
    .poll(() =>
      log.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  const latest = page.getByRole("button", {
    name: en["workbench.returnToLatest"],
    exact: true,
  });
  await log.hover();
  const endTop = await log.evaluate((element) => element.scrollTop);
  for (const delta of [-8, -8, -12, -32]) {
    const previousTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, delta);
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(previousTop - 4);
    await expect(latest).toBeVisible();
  }
  expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(
    endTop - 40,
  );
  await log.press("Control+End");
  await expect(latest).toBeHidden();
});

for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 720, height: 600 },
] as const)
  test(`reviewing receive history stays live and pending data is explained in the totals (${sample.language})`, async ({
    page,
  }, info) => {
    const words = sample.language === "zh" ? zhCN : en;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, { ...sample, sidebarCollapsed: true });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBe(1);
    const log = page.getByRole("log");
    const footer = page.locator(".workbench-stream-totals");
    const footerHeight = (await footer.boundingBox())!.height;
    for (let start = 1; start <= 40; start += 10) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(start, 10),
      );
      await expect(log).toContainText(
        `packet-${String(start + 9).padStart(4, "0")}`,
      );
      await expect
        .poll(() =>
          log.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(24);
    }
    await log.hover();
    const endTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, -180);
    const latest = footer.getByRole("button", {
      name: words["workbench.returnToLatest"],
      exact: true,
    });
    await expect(latest).toBeVisible();
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(endTop - 100);
    const previousTop = await log.evaluate((element) => element.scrollTop);
    for (let start = 41; start <= 60; start += 10) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(start, 10),
      );
      await expect(log).toContainText(
        `packet-${String(start + 9).padStart(4, "0")}`,
      );
    }
    await expect(
      page.getByRole("button", {
        name: words["workbench.freeze"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: words["workbench.resume"],
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(footer).toContainText(
      words["workbench.newUpdates"].replace("{count}", "20"),
    );
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    await expect(latest).toHaveText(
      words["workbench.newUpdates"].replace("{count}", "20"),
    );
    expect(
      Math.abs(
        (await log.evaluate((element) => element.scrollTop)) - previousTop,
      ),
    ).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath("viewing-history.png") });
    await latest.click();
    await expect(latest).toBeHidden();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(24);

    // Reaching the end by native scrolling also restores following.
    await log.hover();
    await page.mouse.wheel(0, -180);
    await expect(latest).toBeVisible();
    await log.press("Control+End");
    await expect(latest).toBeHidden();
    await page
      .getByRole("button", { name: words["workbench.freeze"], exact: true })
      .click();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(61, 7),
    );
    await expect(log).not.toContainText("packet-0067");
    await expect(footer).toContainText(words["workbench.displayPaused"]);
    await expect(footer).toContainText(
      words["workbench.pendingUpdates"].replace("{count}", "7"),
    );
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    await expect(page.getByText("+7", { exact: true })).toHaveCount(0);
    expect(
      await footer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("paused-display-footer.png"),
    });
    await page
      .getByRole("button", { name: words["workbench.resume"], exact: true })
      .click();
    await expect(log).toContainText("packet-0067");
    await expect(footer).not.toContainText(words["workbench.displayPaused"]);
    // Large, wrapped rows settle their browser layout after the initial append.
    // Both live following and reading history must survive those later resizes.
    for (let sequence = 68; sequence <= 70; sequence++) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(sequence, 1, 16384, 804 + (sequence - 68) * 16384),
      );
      await expect(log).toContainText(
        `packet-${String(sequence).padStart(4, "0")}`,
      );
      await expect
        .poll(() =>
          log.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(24);
    }
    await log.hover();
    const largeEndTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, -240);
    await expect(latest).toBeVisible();
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(largeEndTop - 120);
    const largeTop = await log.evaluate((element) => element.scrollTop);
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(71, 1, 16384, 804 + 3 * 16384),
    );
    await expect(log).toContainText("packet-0071");
    await expect(
      page.getByRole("button", {
        name: words["workbench.freeze"],
        exact: true,
      }),
    ).toBeVisible();
    expect(
      Math.abs((await log.evaluate((element) => element.scrollTop)) - largeTop),
    ).toBeLessThanOrEqual(2);
    await latest.click();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(24);
    const options = page.getByRole("button", {
      name: words["workbench.tools.displayOptions"],
      exact: true,
    });
    await options.click();
    await choose(page, words["workbench.historyRecords"], "10");
    await options.click();
    await log.hover();
    await page.mouse.wheel(0, -40);
    await expect(latest).toBeVisible();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(72, 2, 12, 804 + 4 * 16384),
    );
    await expect(latest).toHaveText(
      words["workbench.newUpdates"].replace("{count}", "2"),
    );
    await expect(
      footer.getByText(words["workbench.historyTrimmed"], { exact: true }),
    ).toBeVisible();
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    expect(
      await footer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const spacing = await page.locator(".workbench").evaluate((root) => {
      const rect = (selector: string) => {
        const element = root.querySelector(selector);
        if (!element)
          throw new Error(`Missing receive spacing region ${selector}`);
        return element.getBoundingClientRect();
      };
      const row = rect(".workbench-stream-row:last-child");
      const time = rect(".workbench-stream-row:last-child time");
      const message = rect(
        ".workbench-stream-row:last-child .workbench-stream-content",
      );
      const bytes = rect(
        ".workbench-stream-row:last-child .workbench-stream-meta > span",
      );
      const receive = rect(".workbench-receive-frame");
      const receivedBytes = rect(".workbench-stream-totals > span:last-child");
      const draft = rect(".workbench-draft-frame");
      const draftBytes = rect(".workbench-draft-bytes");
      return {
        timestampInset: row.bottom - time.bottom,
        receiveInset: receive.bottom - receivedBytes.bottom,
        draftInset: draft.bottom - draftBytes.bottom,
        messageGap: time.top - message.bottom,
        byteGap: bytes.left - time.right,
        receiveFooterHeight: rect(".workbench-stream-totals").height,
        draftFooterHeight: draft.bottom - rect(".workbench-draft").bottom,
      };
    });
    await info.attach("receive-spacing", {
      body: JSON.stringify(spacing),
      contentType: "application/json",
    });
    expect(
      Math.abs(spacing.timestampInset - spacing.draftInset),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(spacing.receiveInset - spacing.draftInset),
    ).toBeLessThanOrEqual(0.5);
    expect(Math.abs(spacing.messageGap - spacing.byteGap)).toBeLessThanOrEqual(
      0.5,
    );
    expect(spacing.receiveFooterHeight).toBe(spacing.draftFooterHeight);
    await page.screenshot({
      path: info.outputPath("compact-history-footer.png"),
    });
    expect(errors).toEqual([]);
  });

test("a fragmented continuous burst stays complete below the data budget and clears by byte boundary", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing source");
  const fragment = (index: number) => ({
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      eventSeq: String(index + 11),
      time: { ...source.event.time, sourceMonoNs: String(index * 1_000_000) },
      payload: {
        bytesBase64: Buffer.from("0123456789abcdef").toString("base64"),
        byteStart: String(index * 16),
        byteEnd: String((index + 1) * 16),
      },
    },
  });
  for (let index = 0; index < 5000; index += 100)
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      Array.from({ length: 100 }, (_, offset) => fragment(index + offset)),
    );
  const log = page.getByRole("log");
  const detail = log.locator(".workbench-long-record");
  await expect(detail.locator("summary")).toContainText("80000 B");
  await expect(detail.locator("pre")).toHaveCount(0);
  await detail.locator("summary").click();
  await expect(detail.getByRole("status")).toContainText("1/2");
  const firstPage = await detail.locator("pre").textContent();
  expect(firstPage).toHaveLength(65536);
  await detail.getByRole("button", { name: "Next record page" }).click();
  await expect(detail.getByRole("status")).toContainText("2/2");
  const secondPage = await detail.locator("pre").textContent();
  expect((firstPage ?? "") + (secondPage ?? "")).toBe(
    "0123456789abcdef".repeat(5000),
  );
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(1);
  await expect(
    page.getByText(en["workbench.historyTrimmed"], { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: en["workbench.tools.clearView"], exact: true })
    .click();
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(0);
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    [fragment(5000)],
  );
  await expect(log.locator(".workbench-payload")).toHaveText(
    "0123456789abcdef",
  );
  await expect(
    page.getByText(en["workbench.historyTrimmed"], { exact: true }),
  ).toHaveCount(0);
});

test("controls have a connected-only entry and leave the parameter dialog focused on configuration", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  const button = page.getByRole("button", {
    name: "控制线与回执",
    exact: true,
  });
  await expect(button).toBeDisabled();
  await page
    .getByRole("button", { name: "打开 Virtual serial", exact: true })
    .click();
  await expect(button).toBeEnabled();
  await page.getByRole("button", { name: "连接参数", exact: true }).click();
  const parameters = page.getByRole("dialog", {
    name: "连接参数",
    exact: true,
  });
  await expect(parameters.getByRole("tab")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.hostQueries.filter(
        (action) => action === "session.inputs",
      ),
    ),
  ).toHaveLength(0);
  await parameters.press("Escape");
  const controls = page.getByRole("dialog", {
    name: "控制线与回执",
    exact: true,
  });
  for (let index = 0; index < 6; index++) {
    await button.click();
    await expect(
      controls.getByRole("button", { name: "置位 DTR", exact: true }),
    ).toBeVisible();
    await controls.getByRole("tab", { name: /回执/ }).click();
    await controls.getByRole("tab", { name: "控制线", exact: true }).click();
    await controls.press("Escape");
    await expect(controls).toBeHidden();
  }
  await button.click();
  await controls.screenshot({
    path: info.outputPath("control-lines-and-receipts.png"),
  });
  await expect(
    page.getByText(zhCN["nativeError.hostBusy"], { exact: true }),
  ).toHaveCount(0);
});

for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 880, height: 600 },
] as const)
  test(`receive retention saves and resizes live and paused data (${sample.language})`, async ({
    page,
  }, info) => {
    // 1500 条渲染、冻结、两次保留设置和重载共同验收，保留每步断言的原期限。
    test.setTimeout(60_000);
    const words = sample.language === "zh" ? zhCN : en;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, { ...sample, sidebarCollapsed: true });
    await page.goto("./#/");
    const options = page.getByRole("button", {
      name: words["workbench.tools.displayOptions"],
      exact: true,
    });
    await options.click();
    await choose(page, words["workbench.historyRecords"], "5,000");
    await choose(page, words["workbench.historyCapacity"], "4 MiB");
    await options.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.clientStateWrites.at(-1)?.preferences
              .receiveHistory,
        ),
      )
      .toEqual({ maxRecords: 5000, maxBytes: 4 * 1024 * 1024 });
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBe(1);
    for (let first = 1; first <= 1500; first += 100) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(first, 100),
      );
    }
    const log = page.getByRole("log");
    await expect(log).toContainText("packet-0001");
    await expect(log).toContainText("packet-1500");
    await page
      .getByRole("button", { name: words["workbench.freeze"], exact: true })
      .click();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(1501, 10),
    );
    await expect(log).not.toContainText("packet-1510");
    await options.click();
    await choose(page, words["workbench.historyRecords"], "100");
    await options.click();
    await expect(log).not.toContainText("packet-0001");
    await expect(log).toContainText("packet-1401");
    await expect(log).toContainText("packet-1500");
    await expect(log).not.toContainText("packet-1510");
    await expect(
      page.getByText(words["workbench.historyTrimmed"], { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(words["workbench.gapHelp"], { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: words["workbench.resume"], exact: true })
      .click();
    await expect(log).toContainText("packet-1411");
    await expect(log).toContainText("packet-1510");
    expect(
      await page.evaluate(
        () => window.workbenchFixture.rawSubscriptions.length,
      ),
    ).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.clientStateWrites.at(-1)?.preferences
              .receiveHistory?.maxRecords,
        ),
      )
      .toBe(100);
    await page.reload();
    await page
      .getByRole("button", {
        name: words["workbench.tools.displayOptions"],
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("combobox", { name: words["workbench.historyRecords"] }),
    ).toHaveText("100");
    await expect(
      page.getByRole("combobox", { name: words["workbench.historyCapacity"] }),
    ).toHaveText("4 MiB");
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("receive-retention-options.png"),
    });
  });
