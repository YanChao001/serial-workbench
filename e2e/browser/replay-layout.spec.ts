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
  await expect(
    panel.getByRole("log", { name: "Receive", exact: true }),
  ).toContainText("REPLAY-LAYOUT-CONTENT");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
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
