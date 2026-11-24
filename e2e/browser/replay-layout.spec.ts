/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { CaptureRecord, ReplayRecord } from "@serial-workbench/contracts";
import { session } from "../../src/features/workbench/test-fixtures";
import { en } from "../../src/i18n/en";
import {
  seedWorkbenchFixture,
  type ReplayLayoutFixture,
} from "./workbench.fixture";

test("replay chart traces a compacted and filtered field to both original capture records", async ({
  page,
}) => {
  const replaySession = { ...session("chart-replay"), readOnly: true };
  const bytes = Buffer.alloc(90);
  for (let frame = 1; frame <= 45; frame++)
    bytes.writeUInt16BE(frame, (frame - 1) * 2);
  function capture(
    recordOrdinal: string,
    eventSeq: string,
    start: number,
    chunk: Buffer,
  ): ReplayRecord {
    return {
      kind: "inline",
      record: {
        recordOrdinal,
        entry: {
          kind: "event",
          value: {
            hostId: "workbench-gui-host",
            instanceEpoch: "1",
            sessionId: "recorded-port",
            sessionEpoch: "2",
            configurationRevision: "1",
            eventSeq,
            time: {
              sourceMonoNs: eventSeq,
              clockId: "capture-clock",
              receivedWallTime: "2026-11-24T00:00:00Z",
              precision: {
                source: "host_read",
                resolutionNs: "1",
                syncMethod: "none",
              },
            },
            kind: "rx",
            payload: {
              bytesBase64: chunk.toString("base64"),
              byteStart: String(start),
              byteEnd: String(start + chunk.length),
            },
          },
        },
      },
    };
  }
  await seedWorkbenchFixture(page, {
    language: "en",
    hostStart: "pending",
    replay: {
      session: replaySession,
      files: {},
      page: {
        readerGeneration: "1",
        nextRecord: "45",
        atEnd: true,
        records: [
          capture("39", "51", 100, bytes.subarray(0, 63)),
          capture("40", "52", 163, bytes.subarray(63)),
          {
            kind: "inline",
            record: {
              recordOrdinal: "41",
              entry: {
                kind: "reader_gap",
                value: {
                  hostId: "workbench-gui-host",
                  instanceEpoch: "1",
                  sessionId: "recorded-port",
                  sessionEpoch: "2",
                  reason: "capture_overflow",
                  missingEventRange: { start: "53", end: "54" },
                  missingByteRanges: [
                    { direction: "rx", start: "190", end: "192" },
                  ],
                },
              },
            },
          },
          capture("42", "54", 192, Buffer.from([0, 90])),
          {
            kind: "inline",
            record: {
              recordOrdinal: "43",
              entry: {
                kind: "event",
                value: {
                  hostId: "workbench-gui-host",
                  instanceEpoch: "1",
                  sessionId: "recorded-port",
                  sessionEpoch: "2",
                  configurationRevision: "1",
                  eventSeq: "55",
                  time: {
                    sourceMonoNs: "55",
                    clockId: "capture-clock",
                    receivedWallTime: "2026-11-24T00:00:00Z",
                    precision: {
                      source: "host_read",
                      resolutionNs: "1",
                      syncMethod: "none",
                    },
                  },
                  kind: "gap",
                  payload: {
                    knownExtent: false,
                    direction: "rx",
                    reason: "purge",
                  },
                },
              },
            },
          },
          capture("44", "56", 194, Buffer.from([0, 94])),
        ],
      },
    },
  });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Activity" })
    .getByRole("button", { name: "Locate fixture-attached-replay" })
    .click();
  const replay = page.getByRole("region", { name: "Replay", exact: true });
  await replay.getByRole("button", { name: "Read replay" }).click();
  await replay.getByRole("radio", { name: "HEX", exact: true }).click();
  const raw = replay.getByRole("log").locator("[data-hex-source]");
  await expect(raw).toHaveCount(4);
  await raw.evaluateAll(([first, second]) => {
    const start = first?.firstChild;
    const end = second?.firstChild;
    if (!start || !end) throw new Error("Missing replay HEX payload");
    document.getSelection()?.setBaseAndExtent(start, 62 * 3, end, 2);
  });
  await replay
    .getByRole("button", { name: "Plot selected receive bytes" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Replay field chart" });
  await dialog
    .getByRole("textbox", { name: "First frame byte offset" })
    .fill("100");
  await dialog
    .getByRole("textbox", { name: en["workbench.framing.fixedLength"] })
    .fill("2");
  await dialog
    .getByRole("button", { name: en["workbench.framing.scan"] })
    .click();
  await expect(
    dialog.getByText("46 complete frames", { exact: false }),
  ).toContainText("Some frames cannot be assembled");
  await dialog
    .getByRole("textbox", { name: en["workbench.fields.definition"] })
    .fill(
      JSON.stringify({
        version: "1",
        byteLength: 2,
        fields: [
          {
            id: "voltage",
            kind: "integer",
            byteOffset: 0,
            width: 2,
            order: "big",
            scale: "0.5",
            unit: "V",
          },
        ],
      }),
    );
  await dialog.getByText("Field chart", { exact: true }).click();
  const chart = dialog.getByRole("region", {
    name: "Field chart",
    exact: true,
  });
  await chart.getByRole("button", { name: "Plot fields" }).click();
  await expect(chart.getByRole("status")).toHaveText("Frame 32 · 16 V");
  const drawn = chart.getByRole("img");
  await expect(drawn.locator("polyline")).toHaveCount(2);
  await chart.getByText("Statistics", { exact: true }).click();
  const missing = chart.getByRole("definition").filter({ hasText: /1 \/ / });
  await expect(missing).toHaveText("1 / 47 (2.13%)");
  await chart.getByRole("checkbox", { name: "Compact curve" }).check();
  expect(await drawn.locator("circle").count()).toBeLessThan(46);
  await expect(missing).toHaveText("1 / 47 (2.13%)");

  await chart.getByText("Locate by source byte", { exact: true }).click();
  await chart.getByRole("textbox", { name: "Source event number" }).fill("52");
  await chart.getByRole("textbox", { name: "Source byte offset" }).fill("165");
  await chart.getByRole("button", { name: "Locate byte" }).click();
  await expect(chart.getByRole("status")).toHaveText("Frame 33 · 16.5 V");
  await expect(chart.getByRole("listitem")).toContainText("Capture record 40");

  await chart.getByRole("checkbox", { name: "Last 32 frames" }).check();
  await expect(missing).toHaveText("1 / 33 (3.03%)");
  const cursor = chart.getByRole("slider", { name: "Frame cursor" });
  await cursor.press("End");
  await expect(chart.getByRole("status")).toContainText("45 V");
  for (let move = 0; move < 14; move++) await cursor.press("ArrowLeft");
  await expect(chart.getByRole("status")).toHaveText("Frame 32 · 16 V");
  await expect(chart.getByRole("listitem")).toHaveText([
    /Event 51 · Bytes \[162, 163\) · Capture record 39.*00/,
    /Event 52 · Bytes \[163, 164\) · Capture record 40.*20/,
  ]);
  const field = dialog.getByRole("row", { name: /voltage/ });
  await expect(field).toHaveAttribute("data-chart-selected", "true");
  await expect(field).toContainText("Bytes [162, 164)");
  await expect(
    dialog.getByRole("button", { name: en["workbench.fields.edit"] }),
  ).toHaveCount(0);
  const definition = dialog.getByRole("textbox", {
    name: en["workbench.fields.definition"],
  });
  const originalDefinition = await definition.inputValue();
  await definition.fill(
    JSON.stringify({
      version: "1",
      byteLength: 2,
      fields: [
        {
          id: "voltage",
          kind: "integer",
          byteOffset: 1,
          width: 1,
          order: "big",
          scale: "0.5",
          unit: "V",
        },
        {
          id: "channel",
          kind: "integer",
          byteOffset: 0,
          width: 1,
          order: "big",
        },
      ],
    }),
  );
  await chart.getByRole("button", { name: "Plot fields" }).click();
  const mode = chart.getByRole("combobox", { name: "Plot type" });
  await mode.click();
  await page.getByRole("option", { name: "XY line", exact: true }).click();
  const xy = chart.getByRole("img", {
    name: "XY line of channel versus voltage",
  });
  await expect(xy.locator("polyline")).toHaveCount(1);
  await expect(xy.locator("circle")).toHaveCount(32);
  await expect(chart.getByText(/32 same-frame pairs/)).toBeVisible();
  await xy.locator("circle").last().click();
  await expect(chart.getByRole("status")).toHaveText("Frame 46 · X 45 V · Y 0");
  await expect(
    chart.getByRole("button", { name: "Show Y field bytes" }),
  ).toBeVisible();
  await mode.click();
  await page.getByRole("option", { name: "Scatter", exact: true }).click();
  const scatter = chart.getByRole("img", {
    name: "Scatter plot of channel versus voltage",
  });
  await expect(scatter.locator("circle")).toHaveCount(32);
  await expect(scatter.locator("polyline")).toHaveCount(0);
  await mode.click();
  await page.getByRole("option", { name: "Frame order", exact: true }).click();
  for (let move = 0; move < 14; move++) await cursor.press("ArrowLeft");
  await definition.fill(originalDefinition);
  await chart.getByRole("button", { name: "Plot fields" }).click();
  await expect(chart.getByRole("status")).toHaveText("Frame 32 · 16 V");
  await chart
    .getByRole("button", { name: "Show bytes in receive view" })
    .click();
  await page
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(replay.getByLabel("Selected source bytes")).toContainText(
    "00 20",
  );
  await expect(replay.getByLabel("Selected source bytes")).toContainText(
    "[162, 164)",
  );
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString()))
    .toBe("00 20");
  await replay.getByRole("button", { name: "Read replay" }).click();
  await expect(replay.getByLabel("Selected source bytes")).toHaveCount(0);
});

async function rectangles(page: Page) {
  return page.locator(".workbench").evaluate((root) =>
    Object.fromEntries(
      [
        ".workbench-editor",
        ".workbench-replay",
        ".workbench-replay-toolbar",
        ".workbench-stream-log",
        ".workbench-send",
        ".workbench-draft-frame",
        ".workbench-send-button",
      ].map((selector) => {
        const element = root.querySelector(selector);
        if (!element) throw new Error(`Missing replay layout ${selector}`);
        const { x, y, width, height } = element.getBoundingClientRect();
        return [selector, { x, y, width, height }];
      }),
    ),
  );
}

test("attached replay keeps fixed receive and send rectangles through large-record and settlement details", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  const hostId = "workbench-gui-host";
  const replaySession = { ...session("fixture-replay"), readOnly: true };
  const files: ReplayLayoutFixture["files"] = {};
  const records: ReplayRecord[] = [];
  const body = Buffer.from("REPLAY-LAYOUT-CONTENT\n".repeat(4000));
  for (let index = 0; index < 30; index++) {
    const ordinal = String(index);
    const record: CaptureRecord = {
      recordOrdinal: ordinal,
      entry: {
        kind: "event",
        value: {
          hostId,
          instanceEpoch: "1",
          sessionId: replaySession.sessionId,
          sessionEpoch: replaySession.sessionEpoch,
          eventSeq: String(index + 1),
          configurationRevision: "1",
          time: {
            clockId: "fixture-clock",
            sourceMonoNs: String(index + 1),
            receivedWallTime: "2026-11-10T10:00:00Z",
            precision: {
              source: "host_read",
              resolutionNs: "1",
              syncMethod: "none",
            },
          },
          kind: "rx",
          payload: {
            bytesBase64: body.toString("base64"),
            byteStart: "0",
            byteEnd: String(body.length),
          },
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(record));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const reference = {
      hostId,
      kind: "capture_record",
      id: `replay-record-${ordinal}`,
      revision: "1",
    };
    files[reference.id] = {
      reference,
      bytesBase64: bytes.toString("base64"),
      fingerprint,
    };
    records.push({
      kind: "reference",
      recordOrdinal: ordinal,
      recordRef: reference,
      jsonBytes: String(bytes.length),
      jsonSha256: fingerprint,
    });
  }
  for (let index = 30; index < 50; index++)
    records.push({
      kind: "inline",
      record: {
        recordOrdinal: String(index),
        entry: {
          kind: "tx_settlement",
          value: {
            hostId,
            instanceEpoch: "1",
            receipt: {
              operationId: `private-replay-operation-${index}`,
              sessionId: replaySession.sessionId,
              sessionEpoch: replaySession.sessionEpoch,
              outcome: "accepted",
              bytesBase64: "QQ==",
              byteStart: String(index),
              byteEnd: String(index + 1),
              acceptedRanges: [
                { start: String(index), end: String(index + 1) },
              ],
              unknownRanges: [],
              peerAcknowledged: false,
            },
          },
        },
      },
    });
  const replay: ReplayLayoutFixture = {
    session: replaySession,
    files,
    page: { records, readerGeneration: "1", nextRecord: "50", atEnd: true },
  };
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  await seedWorkbenchFixture(page, {
    sidebarCollapsed: false,
    theme: "dark",
    language: "en",
    hostStart: "pending",
    replay,
  });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  // 已附着的会话不会越过本窗口的工作区选择；通过真实活动定位入口打开视图。
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("dialog", { name: "Activity", exact: true });
  await activity
    .getByRole("button", {
      name: "Locate fixture-attached-replay",
      exact: true,
    })
    .click();
  const panel = page.getByRole("region", { name: "Replay", exact: true });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Read replay", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  const baseline = await rectangles(page);
  for (const name of [
    "Read replay",
    "Pause replay",
    "Resume replay",
    "Seek to record",
  ])
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  await panel.getByRole("button", { name: "Read replay", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("End reached");
  expect(await rectangles(page)).toEqual(baseline);
  await expect(panel).not.toContainText(/private-replay-operation|accepted/);
  await expect(
    panel.getByRole("button", { name: "Read replay 0", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: en["common.details"], exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: en["common.details"],
    exact: true,
  });
  await expect(details).toBeVisible();
  const scroll = await details.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const result = {
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      top: element.scrollTop,
    };
    element.scrollTop = 0;
    return result;
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.height);
  expect(scroll.top).toBeGreaterThan(0);
  expect(await rectangles(page)).toEqual(baseline);
  await details.screenshot({ path: info.outputPath("replay-details.png") });
  await details
    .getByRole("button", { name: "Read replay 0", exact: true })
    .click();
  const record = panel
    .getByRole("log", { name: "Receive", exact: true })
    .locator(".workbench-long-record");
  await expect(record.locator("summary")).toContainText(
    String(body.length) + " B",
  );
  await expect(record.locator("pre")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await record.locator("summary").click();
  await expect(record.locator("pre")).toContainText("REPLAY-LAYOUT-CONTENT");
  expect(await rectangles(page)).toEqual(baseline);
  await expect(panel).not.toContainText(/private-replay-operation|accepted/);
  await page.screenshot({
    path: info.outputPath("replay-expanded-record.png"),
  });
  const evidence = await page.evaluate(() => ({
    queries: window.workbenchFixture.queryInputs.filter(
      (query) =>
        query.actionId === "replay.read" || query.actionId === "file.read",
    ),
    unexpectedCommands: window.workbenchFixture.unexpectedCommands,
    rawSubscriptions: window.workbenchFixture.rawSubscriptions,
    connectCalls: window.workbenchFixture.connectCalls,
  }));
  expect(
    evidence.queries.find((query) => query.actionId === "replay.read")?.params,
  ).toMatchObject({ maxRecords: "100", maxBytes: "65536" });
  expect(
    evidence.queries.filter((query) => query.actionId === "file.read").length,
  ).toBeGreaterThan(1);
  expect(evidence.unexpectedCommands).toEqual([]);
  expect(evidence.rawSubscriptions).toEqual([]);
  expect(evidence.connectCalls).toEqual([]);
  expect(failures).toEqual([]);
  await writeFile(
    info.outputPath("fixture-evidence.json"),
    JSON.stringify(
      {
        source:
          "Explicit headless IPC fixture; not Host or native hardware evidence",
        records: records.length,
        baseline,
        final: await rectangles(page),
        evidence,
        failures,
      },
      null,
      2,
    ),
  );
});

test("attached read-only replay steps, changes speed and stops before its breakpoint", async ({
  page,
}) => {
  const hostId = "workbench-gui-host";
  const replaySession = {
    ...session("fixture-playback"),
    sessionEpoch: "7",
    readOnly: true,
  };
  const scope = {
    sessionId: replaySession.sessionId,
    sessionEpoch: replaySession.sessionEpoch,
  };
  const target = { hostId, kind: "session", id: scope.sessionId, ...scope };
  let byteEnd = 0;
  const records: ReplayRecord[] = [
    "FIRST-STEP",
    "BEFORE-BREAK",
    "AT-BREAK",
    "AFTER-BREAK",
  ].map((text, index) => {
    const body = Buffer.from(text + "\r\n");
    const ordinal = String(index + 1);
    const byteStart = byteEnd;
    byteEnd += body.length;
    return {
      kind: "inline",
      record: {
        recordOrdinal: ordinal,
        entry: {
          kind: "event",
          value: {
            hostId,
            ...scope,
            instanceEpoch: "1",
            eventSeq: ordinal,
            configurationRevision: "1",
            time: {
              clockId: "fixture-playback-clock",
              sourceMonoNs: String(index * 1000),
              receivedWallTime: "2026-11-10T10:00:00Z",
              precision: {
                source: "host_read",
                resolutionNs: "1",
                syncMethod: "none",
              },
            },
            kind: "rx",
            payload: {
              bytesBase64: body.toString("base64"),
              byteStart: String(byteStart),
              byteEnd: String(byteEnd),
            },
          },
        },
      },
    };
  });
  await seedWorkbenchFixture(page, {
    language: "en",
    hostStart: "pending",
    replay: {
      session: replaySession,
      files: {},
      page: {
        records,
        readerGeneration: "1",
        nextRecord: "5",
        atEnd: true,
        playback: {
          rate: { kind: "timed", speedPercent: 100 },
          paused: false,
          breakpointHit: false,
        },
      },
    },
  });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Activity", exact: true })
    .getByRole("button", {
      name: "Locate fixture-attached-replay",
      exact: true,
    })
    .click();

  const panel = page.getByRole("region", { name: "Replay", exact: true });
  const status = panel.getByRole("status");
  const receive = panel.getByRole("log", { name: "Receive", exact: true });
  const options = panel.getByRole("button", { name: "Playback options" });
  const resume = panel.getByRole("button", { name: "Resume replay" });
  const read = panel.getByRole("button", { name: "Read replay", exact: true });
  await panel.getByRole("button", { name: "Step one record" }).click();
  await expect(status).toHaveText("Paused");
  await expect(receive).toContainText("FIRST-STEP");
  await expect(receive).not.toContainText("BEFORE-BREAK");

  await options.click();
  const speed = page.getByRole("combobox", { name: "Replay speed" });
  await expect(speed).toHaveText("100%");
  await speed.click();
  await page.getByRole("option", { name: "200%", exact: true }).click();
  await expect(speed).toHaveText("200%");
  const breakpoint = page.getByRole("textbox", { name: "Breakpoint record" });
  const clear = page.getByRole("button", { name: "Clear breakpoint" });
  await breakpoint.fill("3");
  await page.getByRole("button", { name: "Set breakpoint" }).click();
  await expect(clear).toBeEnabled();
  await page.keyboard.press("Escape");

  await resume.click();
  await expect(status).toHaveText("Next record 2");
  await read.click();
  await expect(status).toHaveText("Breakpoint reached 3");
  await expect(receive).toContainText("BEFORE-BREAK");
  await expect(receive).not.toContainText("AT-BREAK");

  await options.click();
  await expect(breakpoint).toHaveValue("3");
  await clear.click();
  await expect(breakpoint).toHaveValue("");
  await expect(clear).toBeDisabled();
  await expect(status).toHaveText("Paused");
  await page.keyboard.press("Escape");

  await resume.click();
  await expect(status).toHaveText("Next record 3");
  await read.click();
  await expect(status).toHaveText("End reached");
  await expect(receive).toContainText("AT-BREAK");
  await expect(receive).toContainText("AFTER-BREAK");

  const evidence = await page.evaluate(() => {
    const fixture = window.workbenchFixture;
    return {
      queries: fixture.queryInputs.filter(
        (query) =>
          query.actionId === "replay.read" ||
          (query.actionId === "operation.get" &&
            typeof query.params.operationId === "string" &&
            query.params.operationId.startsWith("fixture-replay-control-")),
      ),
      operations: fixture.invocations,
      unexpectedCommands: fixture.unexpectedCommands,
      rawSubscriptions: fixture.rawSubscriptions,
      connectCalls: fixture.connectCalls,
      sentBytes: fixture.sentBytes,
    };
  });
  const readParams = { ...scope, maxBytes: "65536" };
  const inspection = {
    target,
    params: { ...readParams, maxRecords: "1", inspectPlayback: true },
  };
  const readPage = {
    target,
    params: { ...readParams, maxRecords: "100", reportPlayback: true },
  };
  const terminal = (index: number) => ({
    operationId: `fixture-replay-control-${index}`,
  });
  expect(
    evidence.queries.map((query) =>
      query.actionId === "operation.get"
        ? { operationId: query.params.operationId }
        : { target: query.target, params: query.params },
    ),
  ).toEqual([
    {
      target,
      params: {
        ...readParams,
        maxRecords: "1",
        singleStep: true,
        reportPlayback: true,
      },
    },
    terminal(1),
    inspection,
    terminal(2),
    inspection,
    terminal(3),
    inspection,
    readPage,
    terminal(4),
    inspection,
    terminal(5),
    inspection,
    readPage,
  ]);
  expect(
    evidence.operations
      .filter((operation) => operation.actionId === "replay.control")
      .map(({ target, params, executionMode }) => ({
        target,
        params,
        executionMode,
      })),
  ).toEqual([
    controlCall({
      ...scope,
      paused: true,
      playback: {
        kind: "set_rate",
        rate: { kind: "timed", speedPercent: 200 },
      },
    }),
    controlCall({
      ...scope,
      paused: true,
      playback: { kind: "set_breakpoint", record: "3" },
    }),
    controlCall({ ...scope, paused: false }),
    controlCall({
      ...scope,
      paused: true,
      playback: { kind: "set_breakpoint" },
    }),
    controlCall({ ...scope, paused: false }),
  ]);
  function controlCall(params: object) {
    return { target, params, executionMode: "interactive" };
  }
  expect(
    evidence.operations.some(
      (operation) => operation.actionId === "session.tx",
    ),
  ).toBe(false);
  expect(evidence.unexpectedCommands).toEqual([]);
  expect(evidence.rawSubscriptions).toEqual([]);
  expect(evidence.connectCalls).toEqual([]);
  expect(evidence.sentBytes).toEqual([]);
});
