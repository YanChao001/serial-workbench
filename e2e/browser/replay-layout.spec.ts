/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type {
  CaptureRecord,
  ReplayReadResult,
  ReplayRecord,
} from "@serial-workbench/contracts";
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import { operation, session } from "../../src/features/workbench/test-fixtures";
import { en } from "../../src/i18n/en";
import { xyCaptureFixture } from "./xy-capture.fixture";
import {
  seedWorkbenchFixture,
  type ReplayLayoutFixture,
} from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("replay preserves terminal colors while keeping recorded links in the data view", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  const recorded = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (recorded?.kind !== "source")
    throw new Error("Missing recorded RX fixture");
  const label = "Replay device manual";
  const bytes = Buffer.from(
    "\x1b]8;;https://example.invalid/replay\x07\x1b[32m" +
      label +
      "\x1b[0m\x1b]8;;\x07",
  );
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    hostStart: "pending",
    replay: {
      session: { ...session("recorded-ansi"), readOnly: true },
      files: {},
      page: {
        readerGeneration: "1",
        nextRecord: "1",
        atEnd: true,
        records: [
          {
            kind: "inline",
            record: {
              recordOrdinal: "0",
              entry: {
                kind: "event",
                value: {
                  ...recorded.event,
                  kind: "rx",
                  payload: {
                    byteStart: "0",
                    byteEnd: String(bytes.length),
                    bytesBase64: bytes.toString("base64"),
                  },
                },
              },
            },
          },
        ],
      },
    },
  });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page.evaluate(() => window.workbenchFixture.releaseHost());
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "Locate fixture-attached-replay" })
    .click();
  const replay = page.getByRole("region", { name: "Replay", exact: true });
  await replay
    .getByRole("button", { name: "Read replay", exact: true })
    .click();
  await expect(replay.getByRole("log")).toContainText(label);
  await replay
    .getByRole("button", {
      name: "Switch to HEX to inspect original bytes",
    })
    .click();
  await page
    .getByRole("button", { name: "ANSI terminal", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const ansi = replay.getByRole("region", { name: "ANSI terminal" });
  const cell = ansi.locator(".xterm-rows .xterm-fg-2");
  await expect(cell).toHaveText(label);
  await expect(ansi.getByText("Terminal links", { exact: true })).toHaveCount(
    0,
  );
  const bounds = await cell.boundingBox();
  if (!bounds) throw new Error("Missing recorded terminal cell");
  await page.mouse.click(bounds.x + 3, bounds.y + 4);
  expect(
    await page.evaluate(() => window.workbenchFixture.openedExternalLinks),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await ansi.screenshot({ path: info.outputPath("replay-ansi.png") });
});

test("replay chart traces a compacted and filtered field to both original capture records", async ({
  page,
}) => {
  const replaySession = { ...session("chart-replay"), readOnly: true };
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-mdf4/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid MDF4 manifest");
  const [action] = manifest.contributes.actions;
  if (!action) throw new Error("MDF4 export action is missing");
  const output = Buffer.from("MDF     4.10    ", "ascii");
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
              receivedWallTime: "2026-11-24T00:00:00.123456789Z",
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
  const xyFixture = xyCaptureFixture();
  await seedWorkbenchFixture(page, {
    language: "en",
    hostStart: "pending",
    plugin: xyFixture.plugin,
    extraActions: [xyFixture.action],
    framing: {
      action,
      dependencies: [
        { id: manifest.id, version: manifest.version, digest: "c".repeat(64) },
      ],
      page: {
        fileRef: {
          hostId: "workbench-gui-host",
          kind: "plugin_result",
          id: "mdf4-operation",
          revision: "1",
        },
        offset: "0",
        nextOffset: String(output.length),
        totalBytes: String(output.length),
        atEnd: true,
        bytesBase64: output.toString("base64"),
        fingerprint: createHash("sha256").update(output).digest("hex"),
      },
    },
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
  await dialog.getByText("Bus load", { exact: true }).click();
  const bus = dialog.getByRole("region", { name: "Bus load" });
  await expect(bus.getByText(/Clock capture-clock/)).toBeVisible();
  await expect(bus.getByText("Source gap", { exact: true })).toBeVisible();
  await dialog.getByText("Bus load", { exact: true }).click();
  const drawn = chart.getByRole("img");
  await expect(drawn.locator("polyline")).toHaveCount(2);
  await chart.getByText("Statistics", { exact: true }).click();
  const missing = chart.getByRole("definition").filter({ hasText: /1 \/ / });
  await expect(missing).toHaveText("1 / 47 (2.13%)");
  await chart.getByRole("checkbox", { name: "Compact curve" }).check();
  expect(await drawn.locator("circle").count()).toBeLessThan(46);
  await expect(missing).toHaveText("1 / 47 (2.13%)");
  const csv = chart.getByRole("button", { name: "Export CSV", exact: true });
  const exported = () =>
    page.evaluate(() => window.workbenchFixture.savedTextExports.at(-1));
  await csv.click();
  await expect(chart.getByText("Field chart CSV saved.")).toBeVisible();
  const fullExport = await exported();
  expect(fullExport?.name).toBe("serial-workbench-field-chart.csv");
  expect(fullExport?.content.trimEnd().split("\r\n")).toHaveLength(47);

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
  const byteMap = dialog.getByRole("region", {
    name: en["workbench.fields.byteMap"],
  });
  await byteMap.getByRole("button", { name: "Inspect voltage bytes" }).click();
  await expect(byteMap.getByText("Bytes [162, 164)")).toBeVisible();
  await expect(byteMap.getByText("16 V", { exact: true })).toBeVisible();
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
  await csv.click();
  await expect(chart.getByText("Field chart CSV saved.")).toBeVisible();
  const filteredRows = (await exported())?.content.trimEnd().split("\r\n");
  expect(filteredRows).toHaveLength(33);
  expect(filteredRows?.[1]).toMatch(/^15,xy,start,,true,/u);
  expect(filteredRows?.at(-1)).toMatch(/^46,xy,gap,1,true,/u);
  expect(filteredRows?.at(-1)).toContain(",voltage,45,V,90,");
  expect(filteredRows?.at(-1)).toContain(",channel,0,,0,");
  expect(filteredRows?.at(-1)).toContain(
    '""event"":""54"",""start"":""193"",""end"":""194"",""hex"":""5A"",""record"":""42""',
  );
  const stagedAxes = chart.getByRole("region", { name: "Cross-source XY" });
  await stagedAxes.getByRole("button", { name: "Stage as X" }).click();
  await expect(stagedAxes.getByText("X · voltage · 32 samples")).toBeVisible();
  const xField = chart.getByRole("combobox", {
    name: en["workbench.fieldChart.xField"],
  });
  await xField.click();
  await page.getByRole("option", { name: "channel", exact: true }).click();
  await stagedAxes.getByRole("button", { name: "Stage as Y" }).click();
  await expect(stagedAxes.getByText("Y · channel · 32 samples")).toBeVisible();
  await xField.click();
  await page.getByRole("option", { name: "voltage (V)", exact: true }).click();
  const openXy = stagedAxes.getByRole("button", {
    name: "Open cross-source XY",
  });
  await expect(openXy).toBeEnabled();
  await openXy.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeVisible();
  const mdf4 = chart.getByRole("button", { name: "Export MDF4", exact: true });
  await page.evaluate(() => {
    window.workbenchFixture.chartArtifactSaveResult = false;
  });
  await mdf4.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.chartArtifactSaves.length),
    )
    .toBe(1);
  await expect(mdf4).toBeEnabled();
  await expect(chart.getByText("Field chart MDF4 saved.")).toHaveCount(0);
  await page.evaluate(() => {
    window.workbenchFixture.chartArtifactSaveResult = true;
  });
  await mdf4.click();
  await expect(chart.getByText("Field chart MDF4 saved.")).toBeVisible();
  const actionId = action.actionId;
  const invocation = await page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.find((item) => item.actionId === id),
    actionId,
  );
  expect(invocation).toMatchObject({
    target: {
      hostId: "workbench-gui-host",
      kind: "session",
      sessionId: "chart-replay",
      sessionEpoch: replaySession.sessionEpoch,
    },
    executionMode: "independent",
  });
  const snapshot = invocation?.params;
  expect(snapshot?.startTimeNs).toBe(
    String(
      BigInt(Date.parse("2026-11-24T00:00:00Z")) * 1_000_000n + 123_456_789n,
    ),
  );
  const channels = snapshot?.channels;
  expect(channels).toMatchObject([
    { name: "primary_voltage", unit: "V" },
    { name: "paired_channel" },
    { name: "frame_index" },
    { name: "event_start" },
    { name: "event_end" },
    { name: "byte_start" },
    { name: "byte_end" },
    { name: "break_before" },
    { name: "first_record" },
    { name: "last_record" },
  ]);
  const samples = snapshot?.samples;
  expect(Array.isArray(samples)).toBe(true);
  if (!Array.isArray(samples)) throw new Error("Missing MDF4 samples");
  expect(samples).toHaveLength(32);
  expect(samples[0]).toEqual({
    elapsedNs: "0",
    values: ["7.5", "0", "15", "51", "52", "128", "130", "0", "39", "39"],
  });
  expect(samples.at(-1)).toEqual({
    elapsedNs: "3",
    values: ["45", "0", "46", "54", "55", "192", "194", "1", "42", "42"],
  });
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.chartArtifactSaves.at(-1),
    ),
  ).toMatchObject({ operationId: "mdf4-operation" });
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
  await page.goto("./#/plugins?analysis=xy");
  const analysis = page.getByRole("region", { name: "Cross-source XY" });
  await analysis.getByRole("button", { name: "Load staged channels" }).click();
  const input = JSON.parse(
    await analysis
      .getByRole("textbox", { name: "Analysis input (JSON)" })
      .inputValue(),
  );
  expect(input.x.sourceId).toBe("voltage");
  expect(input.y.sourceId).toBe("channel");
  expect(input.x.clockId).toBe(input.y.clockId);
  expect(input.anchors).toBeUndefined();
  expect(input.x.samples).toHaveLength(32);
  expect(input.x.samples[0]).toEqual({ monoNs: "51", value: "7.5" });
  expect(input.x.samples.at(-1)).toEqual({
    monoNs: "54",
    value: "45",
    gapBefore: true,
  });

  await page.evaluate(() => {
    window.workbenchFixture.deniedReplayReads.push("chart-replay");
  });
  await expect(
    analysis.getByRole("textbox", { name: "Analysis input (JSON)" }),
  ).toHaveValue("");
  const loadStaged = analysis.getByRole("button", {
    name: "Load staged channels",
  });
  await expect(loadStaged).toHaveCount(0);
  await page.evaluate(() => {
    window.workbenchFixture.deniedReplayReads.length = 0;
  });
  await expect(loadStaged).toHaveCount(0);
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

for (const {
  language,
  width,
  height,
  browse,
  seek,
  previous,
  next,
  receiveName,
  firstRange,
  lastRange,
  previousRange,
} of [
  {
    language: "en" as const,
    width: 1240,
    height: 760,
    browse: "Browse archive",
    seek: "Seek to record",
    previous: "Previous archive page",
    next: "Next archive page",
    receiveName: "Receive",
    firstRange: "1–100 / 1000000",
    lastRange: "999901–1000000 / 1000000",
    previousRange: "999801–999900 / 1000000",
  },
  {
    language: "zh-CN" as const,
    width: 420,
    height: 530,
    browse: "浏览归档",
    seek: "定位记录",
    previous: "上一页归档",
    next: "下一页归档",
    receiveName: "接收",
    firstRange: "第 1–100 条，共 1000000 条",
    lastRange: "第 999901–1000000 条，共 1000000 条",
    previousRange: "第 999801–999900 条，共 1000000 条",
  },
]) {
  test(`indexed replay displays only the requested archive page at ${width}px (${language})`, async ({
    page,
  }) => {
    const hostId = "workbench-gui-host";
    const replaySession = {
      ...session("archive-replay"),
      sessionEpoch: "7",
      readOnly: true,
    };
    const scope = {
      sessionId: replaySession.sessionId,
      sessionEpoch: replaySession.sessionEpoch,
    };
    const archivePage = (start: number): ReplayReadResult => {
      const records: ReplayRecord[] = Array.from(
        { length: 100 },
        (_, index) => {
          const ordinal = start + index;
          const bytes = Buffer.from(
            `ARCHIVE-${String(ordinal).padStart(7, "0")}\r\n`,
          );
          return {
            kind: "inline",
            record: {
              recordOrdinal: String(ordinal),
              entry: {
                kind: "event",
                value: {
                  hostId,
                  ...scope,
                  instanceEpoch: "1",
                  eventSeq: String(ordinal),
                  configurationRevision: "1",
                  time: {
                    clockId: "archive-fixture-clock",
                    sourceMonoNs: String(ordinal),
                    receivedWallTime: "2026-11-10T10:00:00Z",
                    precision: {
                      source: "host_read",
                      resolutionNs: "1",
                      syncMethod: "none",
                    },
                  },
                  kind: "rx",
                  payload: {
                    bytesBase64: bytes.toString("base64"),
                    byteStart: String((ordinal - 1) * bytes.length),
                    byteEnd: String(ordinal * bytes.length),
                  },
                },
              },
            },
          };
        },
      );
      return {
        records,
        readerGeneration: "1",
        nextRecord: String(start + records.length),
        atEnd: start + records.length === 1000001,
        archiveTotalRecords: "1000000",
      };
    };
    await page.setViewportSize({ width, height });
    await seedWorkbenchFixture(page, {
      language,
      hostStart: "pending",
      replay: {
        session: replaySession,
        files: {},
        page: {
          records: [],
          readerGeneration: "1",
          nextRecord: "1",
          atEnd: true,
        },
        archivePages: {
          "from:1": archivePage(1),
          "from:999901": archivePage(999901),
          "before:999901": archivePage(999801),
        },
      },
    });
    await page.goto("./#/");
    await expect(page.locator(".workbench")).toBeVisible();
    await page.evaluate(() => window.workbenchFixture.releaseHost());
    await page
      .getByRole("button", {
        name: language === "en" ? "Activity" : "活动",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: /fixture-attached-replay/ }).click();
    const panel = page.locator(".workbench-replay");
    const status = panel.getByRole("status");
    const toggle = panel.getByRole("button", { name: browse, exact: true });
    const receive = panel.getByRole("log", { name: receiveName, exact: true });
    await toggle.click();
    await expect(status).toHaveText(firstRange);
    await expect(panel.getByRole("button", { name: previous })).toBeDisabled();
    await expect(
      receive.getByText("ARCHIVE-0000001", { exact: true }),
    ).toBeInViewport();
    const ordinal = panel.getByRole("textbox", { name: seek });
    await ordinal.fill("999901");
    await ordinal.press("Enter");
    await expect(status).toHaveText(lastRange);
    await expect(
      receive.getByText("ARCHIVE-0999901", { exact: true }),
    ).toBeInViewport();
    await expect(
      receive.getByText("ARCHIVE-0000001", { exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByRole("button", { name: next })).toBeDisabled();
    await expect(receive.locator("[data-stream-row-index]")).toHaveCount(100);
    await receive.press("End");
    await expect(
      receive.getByText("ARCHIVE-1000000", { exact: true }),
    ).toBeInViewport();
    await panel.getByRole("button", { name: previous }).click();
    await expect(status).toHaveText(previousRange);
    await expect(
      receive.getByText("ARCHIVE-0999801", { exact: true }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    await page.evaluate(() => {
      window.workbenchFixture.deniedReplayReads.push("archive-replay");
    });
    await expect(toggle).toHaveCount(0);
    await expect(
      receive.getByText("ARCHIVE-0999801", { exact: true }),
    ).toHaveCount(0);
  });
}

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

  await page.setViewportSize({ width: 420, height: 720 });
  const toolbar = page.locator(".workbench-replay-toolbar");
  const toolbarStatus = toolbar.getByRole("status");
  await expect(toolbarStatus).toBeVisible();
  expect(
    await toolbarStatus.evaluate(
      (element) => getComputedStyle(element).whiteSpace,
    ),
  ).toBe("normal");
  const toolbarRect = await toolbar.boundingBox();
  const statusRect = await toolbarStatus.boundingBox();
  expect(statusRect!.width).toBeCloseTo(toolbarRect!.width, 0);
  await expect
    .poll(() =>
      toolbar.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect(
    toolbar.getByRole("button", { name: "Playback options" }),
  ).toBeVisible();
});

test("two recordings compare frame bytes, field values and elapsed time and honor access revocation", async ({
  page,
}, info) => {
  function profile(
    label: string,
    origin: bigint,
    start: number,
    records: number,
    values: number[][],
    offsets: number[],
  ): ReplayLayoutFixture {
    return {
      session: { ...session("replay-" + label), readOnly: true },
      files: {},
      page: {
        readerGeneration: "1",
        nextRecord: String(records + values.length),
        atEnd: true,
        records: values.map((bytes, index) => ({
          kind: "inline",
          record: {
            recordOrdinal: String(records + index),
            entry: {
              kind: "event",
              value: {
                hostId: "workbench-gui-host",
                instanceEpoch: "1",
                sessionId: "recorded-" + label,
                sessionEpoch: "2",
                configurationRevision: "1",
                eventSeq: String(15 + index),
                time: {
                  sourceMonoNs: String(origin + BigInt(offsets[index]!)),
                  clockId: label + "-clock",
                  receivedWallTime: "2026-11-24T00:00:00Z",
                  precision: {
                    source: "host_read",
                    resolutionNs: "1",
                    syncMethod: "none",
                  },
                },
                kind: "rx",
                payload: {
                  bytesBase64: Buffer.from(bytes).toString("base64"),
                  byteStart: String(start + index * 3),
                  byteEnd: String(start + (index + 1) * 3),
                },
              },
            },
          },
        })),
      },
    };
  }
  const baseline = profile(
    "baseline",
    9_007_199_254_740_993n,
    100,
    40,
    [
      [1, 8, 11],
      [2, 7, 13],
    ],
    [0, 21],
  );
  const candidate = profile(
    "candidate",
    9_007_199_254_800_000n,
    200,
    80,
    [
      [1, 8, 77],
      [2, 7, 13],
    ],
    [0, 15],
  );
  await seedWorkbenchFixture(page, {
    language: "en",
    replay: baseline,
    replayPeer: candidate,
  });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();

  async function stage(start: string, action: string) {
    const replay = page.getByRole("region", { name: "Replay", exact: true });
    await replay.getByRole("button", { name: "Read replay" }).click();
    await replay
      .getByRole("button", { name: "Replay field chart", exact: true })
      .click();
    const chart = page.getByRole("dialog", { name: "Replay field chart" });
    await chart
      .getByRole("textbox", { name: "First frame byte offset" })
      .fill(start);
    await chart
      .getByRole("textbox", {
        name: en["workbench.framing.fixedLength"],
        exact: true,
      })
      .fill("3");
    await chart
      .getByRole("button", { name: en["workbench.framing.scan"] })
      .click();
    await chart.getByRole("button", { name: action }).click();
    await expect(chart).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Activity" })
    .getByRole("button", {
      name: "Locate fixture-attached-replay",
      exact: true,
    })
    .click();
  await stage("100", "Use as baseline");
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Open replay", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.invocations.filter(
            ({ actionId }) => actionId === "replay.open",
          ).length,
      ),
    )
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Replay field chart", exact: true }),
  ).toBeDisabled();
  await stage("200", "Use as comparison");
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.queryInputs.some(
        ({ actionId, target }) =>
          actionId === "replay.read" && target.id === "replay-candidate",
      ),
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Recording comparison (2/2)" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Recording comparison" });
  await expect(
    dialog.getByText("recorded-baseline @ 2", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("recorded-candidate @ 2", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Frame alignment" }).click();
  await page
    .getByRole("option", { name: "Protocol fields", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: /Field IDs/ })
    .fill("unit,register");
  await dialog
    .getByRole("textbox", { name: "Protocol field definition", exact: true })
    .fill(
      JSON.stringify({
        version: "1",
        byteLength: 3,
        fields: ["unit", "register", "value"].map((id, byteOffset) => ({
          id,
          kind: "integer",
          width: 1,
          order: "big",
          byteOffset,
        })),
      }),
    );
  await dialog.getByRole("button", { name: "Compare frames" }).click();
  const report = dialog.getByRole("region", { name: "Comparison results" });
  await expect(report.getByText("01 08 0B", { exact: true })).toBeVisible();
  await expect(report.getByText("01 08 4D", { exact: true })).toBeVisible();
  await expect(
    report.getByText("Capture records 40–40", { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText("Capture records 80–80", { exact: true }),
  ).toBeVisible();
  await expect(
    report.getByText("value · 11 [0B] → 77 [4D]", { exact: true }),
  ).toBeVisible();
  await expect(report.getByText("[2, 3)", { exact: true })).toBeVisible();
  await expect(
    report.getByRole("cell", { name: "-6", exact: true }),
  ).toBeVisible();

  await dialog.screenshot({
    path: info.outputPath("replay-comparison-wide.png"),
  });
  await page.setViewportSize({ width: 420, height: 720 });
  const baselineCard = dialog
    .getByRole("heading", { name: "Baseline", exact: true })
    .first();
  const comparisonCard = dialog
    .getByRole("heading", { name: "Comparison", exact: true })
    .first();
  expect((await comparisonCard.boundingBox())!.y).toBeGreaterThan(
    (await baselineCard.boundingBox())!.y,
  );
  const table = report.getByRole("region", { name: "Frame comparison table" });
  await expect
    .poll(() =>
      table.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      dialog
        .locator(".workbench-dialog-body")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await table.focus();
  await expect(table).toBeFocused();
  await dialog.screenshot({
    path: info.outputPath("replay-comparison-narrow.png"),
  });
  await table.press("ArrowRight");
  await expect
    .poll(() => table.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    window.workbenchFixture.deniedReplayReads.push("replay-baseline");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(report).toHaveCount(0);
  await expect(
    dialog.getByText("No source selected", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("recorded-candidate @ 2", { exact: true }),
  ).toBeVisible();
});

for (const options of [
  {
    width: 410,
    height: 460,
    language: "zh",
    theme: "dark",
    activity: "活动",
    title: "搜索录制",
    content: "搜索内容",
    direction: "方向",
    start: "开始搜索",
    jump: "跳转到记录",
    located: "已定位录制序号 2",
  },
  {
    width: 1240,
    height: 760,
    language: "en",
    theme: "light",
    activity: "Activity",
    title: "Search recording",
    content: "Search content",
    direction: "Direction",
    start: "Start search",
    jump: "Go to record",
    located: "Located record 2",
  },
] as const) {
  test(
    "recording search shares narrow and wide controls at " + options.width,
    async ({ page }, info) => {
      await page.setViewportSize({
        width: options.width,
        height: options.height,
      });
      await page.emulateMedia({ colorScheme: options.theme });
      const capture = {
        ...session("search-replay"),
        sessionEpoch: "7",
        readOnly: true,
      };
      const records: ReplayRecord[] = ["before", "PING-match", "after"].map(
        (text, index) => ({
          kind: "inline",
          record: {
            recordOrdinal: String(index + 1),
            entry: {
              kind: "event",
              value: {
                hostId: "workbench-gui-host",
                instanceEpoch: "1",
                sessionId: capture.sessionId,
                sessionEpoch: capture.sessionEpoch,
                eventSeq: String(index + 1),
                configurationRevision: "1",
                time: {
                  clockId: "search-clock",
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
                  bytesBase64: Buffer.from(text).toString("base64"),
                  byteStart: String(index * 20),
                  byteEnd: String(index * 20 + text.length),
                },
              },
            },
          },
        }),
      );
      await seedWorkbenchFixture(page, {
        language: options.language,
        theme: options.theme,
        hostStart: "pending",
        replay: {
          session: capture,
          files: {},
          page: {
            records,
            readerGeneration: "1",
            nextRecord: "4",
            atEnd: true,
            playback: {
              rate: { kind: "fastest" },
              paused: false,
              breakpointHit: false,
            },
          },
          searchPages: [
            {
              hits: [],
              scannedRecords: "1",
              totalRecords: "3",
              complete: false,
            },
            {
              hits: [
                {
                  direction: "rx",
                  firstRecord: "2",
                  lastRecord: "3",
                  byteStart: "20",
                  byteEnd: "25",
                },
              ],
              scannedRecords: "3",
              totalRecords: "3",
              complete: true,
            },
          ],
        },
      });
      await page.goto("./#/");
      await expect(page.locator(".workbench")).toBeVisible();
      await page.evaluate(() => window.workbenchFixture.releaseHost());
      await page
        .getByRole("button", { name: options.activity, exact: true })
        .click();
      await page
        .getByRole("dialog", { name: options.activity })
        .getByRole("button", { name: /fixture-attached-replay/ })
        .click();
      const trigger = page.getByRole("button", { name: options.title });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: options.title });
      const input = dialog.getByRole("textbox", { name: options.content });
      await expect(input).toBeFocused();
      await input.fill("PING");
      await dialog.getByRole("button", { name: options.start }).click();
      const go = dialog.getByRole("button", { name: options.jump });
      await expect(go).toBeVisible();
      const geometry = await dialog.evaluate((element) => {
        const children = [
          ...element.querySelectorAll(
            ".workbench-replay-search-fields input, .workbench-replay-search-fields button",
          ),
        ];
        const rect = element.getBoundingClientRect();
        return {
          contained: children.every((child) => {
            const part = child.getBoundingClientRect();
            return part.left >= rect.left && part.right <= rect.right;
          }),
          controlHeightSpread:
            Math.max(
              ...children.map((child) => child.getBoundingClientRect().height),
            ) -
            Math.min(
              ...children.map((child) => child.getBoundingClientRect().height),
            ),
        };
      });
      expect(geometry.contained).toBe(true);
      expect(geometry.controlHeightSpread).toBeLessThan(1);
      const directionText = dialog
        .getByRole("combobox", { name: options.direction, exact: true })
        .locator('[data-slot="select-value"]');
      expect(
        await directionText.evaluate(
          (label) => label.scrollWidth - label.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await dialog.screenshot({
        path: info.outputPath(`replay-search-${options.width}.png`),
      });
      await go.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.getByText(new RegExp(options.located))).toBeVisible();
      await expect(
        page.getByRole("log").filter({ hasText: "PING-match" }),
      ).toBeVisible();
      const calls = await page.evaluate(() =>
        window.workbenchFixture.queryInputs.filter(
          (item) => item.actionId === "replay.search",
        ),
      );
      expect(calls[0]?.params.command).toMatchObject({
        kind: "start",
        bytesBase64: "UElORw==",
      });
      expect(calls[1]?.params.command).toMatchObject({
        kind: "next",
        page: "2",
      });
    },
  );
}

test("keeps interactive recorded sends on the simulated peer and clears responses on lost access", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 660 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page.evaluate(
    ({ snapshotJson, receiptJson }) => {
      const snapshot: unknown = JSON.parse(snapshotJson);
      const receipt: unknown = JSON.parse(receiptJson);
      const native: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
      const object = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null;
      if (
        !object(native) ||
        typeof native.invoke !== "function" ||
        !object(snapshot) ||
        !object(receipt)
      )
        throw new Error("Missing recorded peer fixture");
      const invoke = native.invoke;
      const fixture = {
        allowed: true,
        eligible: true,
        tooLarge: false,
        invocations: [] as unknown[],
      };
      Reflect.set(window, "recordedPeerFixture", fixture);
      const source = {
        hostId: "workbench-gui-host",
        kind: "file",
        id: "recorded-source",
        revision: "1",
      };
      let progress = {
        revision: "1",
        completedTurns: "0",
        remainingRequestBytes: "3",
        responseStart: "0",
        responseCount: "0",
        atEnd: false,
      };
      let responses: { recordOrdinal: string; bytesBase64: string }[] = [];
      Reflect.set(
        native,
        "invoke",
        async (command: string, args: Record<string, unknown> = {}) => {
          if (
            command === "choose_file_resource" &&
            args.role === "capturePeerSource"
          ) {
            return {
              reference: source,
              name: "controller.swbc",
              length: "850",
              mime: "application/octet-stream",
            };
          }
          const request = args.request;
          if (
            command === "host_request" &&
            object(request) &&
            object(request.params)
          ) {
            const call = request.params;
            const target = call.target;
            if (request.method === "action.query" && object(target)) {
              if (
                call.actionId === "session.get" &&
                target.id === snapshot.sessionId
              )
                return {
                  ok: true,
                  result: { kind: "session", value: snapshot },
                };
              if (
                call.actionId === "action.check" &&
                object(call.params) &&
                (call.params.actionId === "replay.peer.state" ||
                  call.params.actionId === "replay.peer.close")
              )
                return {
                  ok: true,
                  result: {
                    kind: "action_check",
                    value: {
                      actionId: call.params.actionId,
                      target,
                      allowed:
                        call.params.actionId === "replay.peer.close" ||
                        fixture.allowed,
                    },
                  },
                };
              if (call.actionId === "replay.peer.state")
                return {
                  ok: true,
                  result: {
                    kind: "replay_peer_state",
                    value: {
                      sessionId: snapshot.sessionId,
                      sessionEpoch: snapshot.sessionEpoch,
                      progress,
                      responses,
                    },
                  },
                };
            }
            if (
              request.method === "action.invoke" &&
              (call.actionId === "replay.peer.open" ||
                call.actionId === "replay.peer.submit" ||
                call.actionId === "replay.peer.close")
            ) {
              fixture.invocations.push({
                actionId: call.actionId,
                target,
                params: call.params,
                revision: call.expectedRevision,
              });
              const operationId = crypto.randomUUID();
              const base = {
                ...receipt,
                operationId,
                rootOperationId: operationId,
                executionHostId: call.hostId,
                requestId: call.requestId,
                actionId: call.actionId,
                target,
                executionMode: "independent",
                owner: { kind: "host", id: call.hostId },
                revealTarget: {
                  pageId: "workbench",
                  sessionId: snapshot.sessionId,
                },
              };
              if (call.actionId === "replay.peer.open" && !fixture.eligible)
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...base,
                      state: "failed",
                      error: {
                        code: "REPLAY_PEER_INELIGIBLE",
                        message: "Incomplete recorded source",
                        retryable: false,
                      },
                    },
                  },
                };
              if (call.actionId === "replay.peer.open")
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...base,
                      result: {
                        kind: "opened",
                        value: {
                          sessionId: snapshot.sessionId,
                          sessionEpoch: snapshot.sessionEpoch,
                          revision: "1",
                          reused: false,
                        },
                      },
                    },
                  },
                };
              if (call.actionId === "replay.peer.close")
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...base,
                      result: {
                        kind: "replay_peer_closed",
                        value: {
                          sessionId: snapshot.sessionId,
                          sessionEpoch: snapshot.sessionEpoch,
                          revision: "4",
                        },
                      },
                    },
                  },
                };
              if (fixture.tooLarge)
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...base,
                      state: "failed",
                      error: {
                        code: "REPLAY_PEER_LIMIT",
                        message: "Recording grew",
                        retryable: false,
                      },
                    },
                  },
                };
              const data = object(call.params) ? call.params.bytesBase64 : null;
              if (data === "AQ==" && call.expectedRevision === "1") {
                progress = {
                  revision: "2",
                  completedTurns: "0",
                  remainingRequestBytes: "2",
                  responseStart: "0",
                  responseCount: "0",
                  atEnd: false,
                };
              } else if (data === "AgM=" && call.expectedRevision === "2") {
                progress = {
                  revision: "3",
                  completedTurns: "1",
                  remainingRequestBytes: "1",
                  responseStart: "0",
                  responseCount: "1",
                  atEnd: false,
                };
                responses = [{ recordOrdinal: "8", bytesBase64: "3q0=" }];
              } else {
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...base,
                      state: "failed",
                      error: {
                        code: "REPLAY_PEER_MISMATCH",
                        message: "Unexpected byte",
                        retryable: false,
                        details: {
                          turn: 1,
                          matchedBytes: 1,
                          mismatchOffset: 1,
                        },
                      },
                    },
                  },
                };
              }
              return {
                ok: true,
                result: {
                  operation: {
                    ...base,
                    result: { kind: "replay_peer_progress", value: progress },
                  },
                },
              };
            }
          }
          return Reflect.apply(invoke, native, [command, args]);
        },
      );
    },
    {
      snapshotJson: JSON.stringify({
        ...session("replay-peer-demo"),
        readOnly: true,
      }),
      receiptJson: JSON.stringify(operation(crypto.randomUUID())),
    },
  );
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Open replay", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Simulate recorded peer", exact: true })
    .click();
  const peer = page.getByRole("region", { name: "Recorded peer", exact: true });
  const input = peer.getByRole("textbox", { name: "Input HEX" });
  const send = peer.getByRole("button", { name: "Send to simulated peer" });
  await expect(
    peer.getByText("controller.swbc", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", {
      name: "Recorded peer · controller.swbc",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".workbench-send")).toHaveCount(0);
  await input.fill("01");
  await send.click();
  await expect(peer.getByRole("status")).toContainText("2 bytes left");
  await input.fill("FF");
  await send.click();
  await expect(peer.getByRole("alert")).toContainText("differs at byte 2");
  await expect(input).toHaveValue("FF");
  await input.fill("02 03");
  await send.click();
  await expect(peer.getByText("DE AD", { exact: true })).toBeVisible();
  await expect(peer.getByText("RX · record 8", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  await page.screenshot({ path: info.outputPath("recorded-peer-narrow.png") });
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.screenshot({ path: info.outputPath("recorded-peer-wide.png") });

  const observed: unknown = await page.evaluate(() =>
    Reflect.get(Reflect.get(window, "recordedPeerFixture"), "invocations"),
  );
  expect(observed).toEqual([
    expect.objectContaining({
      actionId: "replay.peer.open",
      params: {
        captureRef: expect.objectContaining({ id: "recorded-source" }),
      },
    }),
    ...[
      ["AQ==", "1"],
      ["/w==", "2"],
      ["AgM=", "2"],
    ].map(([bytesBase64, revision]) => ({
      actionId: "replay.peer.submit",
      params: { bytesBase64 },
      revision,
      target: {
        hostId: "workbench-gui-host",
        kind: "session",
        id: "replay-peer-demo",
        sessionId: "replay-peer-demo",
        sessionEpoch: "1",
      },
    })),
  ]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await page.evaluate(() =>
    Reflect.set(Reflect.get(window, "recordedPeerFixture"), "tooLarge", true),
  );
  await input.fill("04");
  await send.click();
  await expect(peer.getByRole("alert")).toContainText(
    "exceeds the simulation size limit",
  );
  await expect(peer.getByText("DE AD", { exact: true })).toBeHidden();
  await page.evaluate(() =>
    Reflect.set(Reflect.get(window, "recordedPeerFixture"), "allowed", false),
  );
  await expect(peer.getByText("DE AD", { exact: true })).toBeHidden();
  await expect(peer.getByRole("status")).toContainText(
    "recording is unavailable",
  );
  await page
    .getByRole("button", { name: "Close session", exact: true })
    .click();
  await expect(peer.getByRole("status")).toContainText(
    "simulated peer is closed",
  );
  const closed: unknown = await page.evaluate(() =>
    Reflect.get(Reflect.get(window, "recordedPeerFixture"), "invocations").at(
      -1,
    ),
  );
  expect(closed).toEqual(
    expect.objectContaining({
      actionId: "replay.peer.close",
      target: expect.objectContaining({
        id: "replay-peer-demo",
        sessionEpoch: "1",
      }),
    }),
  );
  await page.evaluate(() =>
    Reflect.set(Reflect.get(window, "recordedPeerFixture"), "eligible", false),
  );
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Open replay", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Simulate recorded peer", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Use Open replay to inspect this recording" }),
  ).toBeVisible();
});
