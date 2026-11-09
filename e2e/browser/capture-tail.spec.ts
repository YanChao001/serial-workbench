/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  CaptureTailResult,
  ObjectRef,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import { seedWorkbenchFixture } from "./workbench.fixture";

// Explicit verified-history replies. They are UI evidence, never real Host/hardware recordings.
const refA: ObjectRef = {
  hostId: "workbench-gui-host",
  kind: "file",
  id: "recording-a",
  revision: "3",
};
const refB: ObjectRef = {
  hostId: "workbench-gui-host",
  kind: "capture",
  id: "recording-b",
};
function tail(reference: ObjectRef, text: string): CaptureTailResult {
  const historical = {
    hostId: "original-host",
    instanceEpoch: "9",
    sessionId: "old-device",
    sessionEpoch: "7",
  };
  const bytes = Buffer.from(text);
  return {
    captureRef: reference.revision
      ? reference
      : { ...reference, revision: "8" },
    sourceFingerprint: "a".repeat(64),
    state: "incomplete",
    verifiedPrefix: "45",
    containerComplete: false,
    sourceContinuous: false,
    firstRecord: "41",
    records: [
      {
        kind: "inline",
        record: {
          recordOrdinal: "41",
          entry: {
            kind: "event",
            value: {
              ...historical,
              eventSeq: "1",
              configurationRevision: "1",
              time: {
                clockId: "old-clock",
                sourceMonoNs: "123",
                receivedWallTime: "2026-11-08T00:00:00Z",
                precision: {
                  source: "host_read",
                  resolutionNs: "1",
                  syncMethod: "none",
                },
              },
              kind: "rx",
              payload: {
                bytesBase64: bytes.toString("base64"),
                byteStart: "0",
                byteEnd: String(bytes.length),
              },
            },
          },
        },
      },
      {
        kind: "inline",
        record: {
          recordOrdinal: "42",
          entry: {
            kind: "reader_gap",
            value: {
              ...historical,
              reason: "reader_overflow",
              missingEventRange: { start: "2", end: "3" },
            },
          },
        },
      },
      {
        kind: "inline",
        record: {
          recordOrdinal: "43",
          entry: {
            kind: "tx_settlement",
            value: {
              hostId: historical.hostId,
              instanceEpoch: historical.instanceEpoch,
              receipt: {
                operationId: "unknown-write",
                sessionId: historical.sessionId,
                sessionEpoch: historical.sessionEpoch,
                outcome: "unknown",
                bytesBase64: "QQ==",
                byteStart: "0",
                byteEnd: "1",
                acceptedRanges: [],
                unknownRanges: [{ start: "0", end: "1" }],
                peerAcknowledged: false,
              },
            },
          },
        },
      },
      {
        kind: "reference",
        recordOrdinal: "44",
        jsonBytes: "999999",
        jsonSha256: "d".repeat(64),
        recordRef: {
          hostId: reference.hostId,
          kind: "capture_record",
          id: "large-record",
          revision: "1",
        },
      },
    ],
  };
}
const workspace: WorkspaceDocument = {
  ...defaults.workspace,
  name: "Saved recordings",
  captures: [refA, refB],
};
const record = new WeakMap<
  Page,
  { errors: string[]; console: { type: string; text: string }[] }
>();
test.beforeEach(async ({ page }) => {
  const value = {
    errors: [] as string[],
    console: [] as { type: string; text: string }[],
  };
  record.set(page, value);
  page.on("pageerror", (e) => value.errors.push(e.message));
  page.on("console", (m) => {
    value.console.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") value.errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.url().includes("/assets/") && r.status() >= 400)
      value.errors.push(`${r.status()} ${r.url()}`);
  });
});
test.afterEach(async ({ page }, info) => {
  const fixture = await page.evaluate(() => window.workbenchFixture);
  await writeFile(
    info.outputPath("runtime-and-ipc.json"),
    JSON.stringify({ ...record.get(page), fixture }, null, 2),
  );
  expect(record.get(page)?.errors).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
  for (const request of fixture.captureTailRequests) {
    expect(request.transport).toBe("raw");
    expect(request.query).toMatchObject({
      protocolVersion: "0.1",
      hostId: "workbench-gui-host",
      instanceEpoch: "1",
      actorId: "workbench-gui-actor",
      actionId: "capture.tail",
      params: { maxRecords: "100", maxBytes: "262144" },
    });
    expect(request.query.target.id).toBe(
      (request.query.params.captureRef as ObjectRef).id,
    );
  }
  expect(fixture.hostQueries).not.toContain("file.read");
  expect(
    fixture.invocations.filter((c) =>
      ["session.tx", "replay.open", "capture.stop", "capture.recover"].includes(
        c.actionId,
      ),
    ),
  ).toEqual([]);
});
function recording(page: Page, n: number) {
  return page.getByRole("tab", {
    name: `Recording ${n} \u00b7 Read only`,
    exact: true,
  });
}
function panel(page: Page) {
  return page.getByRole("region", { name: "Recording", exact: true });
}
async function captureEvidence(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await writeFile(
    info.outputPath(`${name}-axe.json`),
    JSON.stringify(axe, null, 2),
  );
  expect(axe.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function openTool(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function waitAnotherPermissionObservation(page: Page) {
  const before = await page.evaluate(
    () => window.workbenchFixture.capturePermissionChecks.length,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => window.workbenchFixture.capturePermissionChecks.length,
      ),
    )
    .toBeGreaterThan(before);
}

test("saved recording refs restore readonly Raw tails, retain drafts, and persist only explicit layout changes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1120, height: 744 });
  await seedWorkbenchFixture(page, {
    workspace,
    drafts: { unconnected: "UNBOUND ORIGINAL" },
    captureTails: {
      results: {
        [refA.id]: tail(refA, "SAVED_A_BODY"),
        [refB.id]: tail(refB, "SAVED_B_BODY"),
      },
    },
  });
  await page.goto("./#/");
  await expect(
    page.getByRole("button", { name: "Saved recordings", exact: true }),
  ).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const sender = page.getByRole("region", { name: "Send", exact: true });
  const log = panel(page).getByRole("log", { name: "Receive", exact: true });
  async function readBodyGeometry() {
    return log.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const rows = [...element.querySelectorAll(".workbench-stream-row")]
        .slice(0, 2)
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        });
      const padding =
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        top: bounds.top,
        bottom: bounds.bottom,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        rows,
        requiredHeight: rows.reduce(
          (total, row) => total + row.height,
          padding,
        ),
      };
    });
  }
  async function expectReadableBody(stage: string, focusBody = true) {
    await expect(log.locator(".workbench-stream-row")).toHaveCount(2);
    if (focusBody) {
      await log.scrollIntoViewIfNeeded();
      await log.focus();
      await log.press("Control+Home");
    }
    const geometry = await readBodyGeometry();
    await writeFile(
      info.outputPath(`${stage}-geometry.json`),
      JSON.stringify(geometry, null, 2),
    );
    await page.screenshot({ path: info.outputPath(`${stage}.png`) });
    await expect
      .poll(async () => {
        const current = await readBodyGeometry();
        return current.clientHeight - current.requiredHeight;
      })
      .toBeGreaterThanOrEqual(-1);
    const final = await readBodyGeometry();
    expect(
      final.rows.every(
        (row) => row.top >= final.top - 1 && row.bottom <= final.bottom + 1,
      ),
    ).toBe(true);
    await expect(
      log.locator(".workbench-payload").filter({ hasText: "SAVED_A_BODY" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(log.locator(".workbench-gap")).toBeInViewport({ ratio: 1 });
  }
  await expect(draft).toHaveValue("UNBOUND ORIGINAL");
  await draft.fill("UNBOUND EDIT KEPT");
  await recording(page, 1).click();
  await expect(panel(page)).toContainText("SAVED_A_BODY");
  await expectReadableBody("default-tail-1120");
  const healthyInformationTrigger = panel(page).getByRole("button", {
    name: "Recording · Expand",
    exact: true,
  });
  await healthyInformationTrigger.focus();
  await healthyInformationTrigger.press("Enter");
  const healthyInformation = page.getByRole("dialog", {
    name: "Recording",
    exact: true,
  });
  await expect(healthyInformation).toContainText(
    "Verified prefix of a partial recording",
  );
  await expect(healthyInformation).toContainText("a".repeat(64));
  const healthyBaseline = await page.evaluate(
    (reference) => ({
      checks: window.workbenchFixture.capturePermissionChecks.filter(
        (check) => check.id === reference.id && check.decision === "allow",
      ).length,
      rawReads: window.workbenchFixture.captureTailRequests.filter(
        (request) =>
          JSON.stringify(request.query.params.captureRef) ===
          JSON.stringify(reference),
      ).length,
    }),
    refA,
  );
  // Checks are sequential. Starting a third same-ref check proves the first two
  // completed; the explicit allow fixture returns synchronously without deferral.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.workbenchFixture.capturePermissionChecks.filter(
            (check) => check.id === id && check.decision === "allow",
          ).length,
        refA.id,
      ),
    )
    .toBeGreaterThanOrEqual(healthyBaseline.checks + 3);
  const healthyAfter = await page.evaluate(
    (reference) => ({
      checks: window.workbenchFixture.capturePermissionChecks.filter(
        (check) => check.id === reference.id && check.decision === "allow",
      ).length,
      rawReads: window.workbenchFixture.captureTailRequests.filter(
        (request) =>
          JSON.stringify(request.query.params.captureRef) ===
          JSON.stringify(reference),
      ).length,
    }),
    refA,
  );
  const popupSurvived = await healthyInformation.isVisible();
  await writeFile(
    info.outputPath("healthy-permission-cycles.json"),
    JSON.stringify(
      {
        reference: refA,
        baseline: healthyBaseline,
        after: healthyAfter,
        popupSurvived,
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: info.outputPath("healthy-permission-cycles.png"),
  });
  expect({ popupSurvived, rawReads: healthyAfter.rawReads }).toEqual({
    popupSurvived: true,
    rawReads: healthyBaseline.rawReads,
  });
  await expect(healthyInformation).toContainText(
    "Verified prefix of a partial recording",
  );
  await expect(healthyInformation).toContainText("a".repeat(64));
  await healthyInformation.press("Escape");
  await expect(healthyInformation).toHaveCount(0);
  await expect(healthyInformationTrigger).toBeFocused();
  await page.setViewportSize({ width: 880, height: 600 });
  await expectReadableBody("default-tail-880");
  const draftInformationTrigger = sender.getByRole("button", {
    name: "Unconnected draft · Save current layout · Expand",
    exact: true,
  });
  for (const viewport of [
    { width: 1120, height: 744 },
    { width: 880, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("button", { name: "Save current layout", exact: true }),
    ).toBeDisabled();
    await expect(
      sender.getByRole("button", { name: "Save drafts", exact: true }),
    ).toBeVisible();
    await draftInformationTrigger.focus();
    await draftInformationTrigger.press("Enter");
    const draftInformation = page.getByRole("dialog", {
      name: "Unconnected draft",
      exact: true,
    });
    await expect(draftInformation).toBeVisible();
    await expect(draftInformation).toContainText(
      "The current draft has no device binding. Connect before saving the window layout. Drafts can be saved separately.",
    );
    await expectReadableBody(`draft-information-open-${viewport.width}`, false);
    await draftInformation.press("Escape");
    await expect(draftInformation).toHaveCount(0);
    await expect(draftInformationTrigger).toBeFocused();
    await expectReadableBody(
      `draft-information-closed-${viewport.width}`,
      false,
    );
    await expect(draftInformationTrigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1120, height: 744 });
  await expect(draft).toBeEditable();
  await expect(draft).toHaveValue("UNBOUND EDIT KEPT");
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await draft.fill("43 41 50 54 55 52 45");
  await sender.getByRole("radio", { name: "HEX", exact: true }).click();
  await sender
    .getByRole("combobox", { name: "Line ending", exact: true })
    .click();
  await page.getByRole("option", { name: "LF", exact: true }).click();
  await recording(page, 2).click();
  await expect(panel(page)).toContainText("SAVED_B_BODY");
  await expect(draft).toHaveValue("43 41 50 54 55 52 45");
  await expect(
    sender.getByRole("radio", { name: "HEX", exact: true }),
  ).toBeChecked();
  await expect(
    sender.getByRole("combobox", { name: "Line ending", exact: true }),
  ).toHaveText("LF");
  await page.getByRole("tab", { name: "Send draft", exact: true }).click();
  await expect(draft).toHaveValue("43 41 50 54 55 52 45");
  await expect(
    sender.getByRole("radio", { name: "HEX", exact: true }),
  ).toBeChecked();
  await expect(
    sender.getByRole("combobox", { name: "Line ending", exact: true }),
  ).toHaveText("LF");
  await sender.getByRole("radio", { name: "Text", exact: true }).click();
  await sender
    .getByRole("combobox", { name: "Line ending", exact: true })
    .click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const deviceTab = page.getByRole("tab", {
    name: "Virtual serial",
    exact: true,
  });
  await expect(deviceTab).toHaveAttribute("aria-selected", "true");
  await expect(draft).toHaveValue("43 41 50 54 55 52 45");
  await draft.fill("DEVICE EDIT KEPT");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts["session-session"] === "DEVICE EDIT KEPT",
        ),
      ),
    )
    .toBe(true);
  await recording(page, 1).click();
  await expect(panel(page)).toContainText("SAVED_A_BODY");
  await expect(
    page.getByRole("combobox", { name: "Choose device", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^Connection parameters/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /^(Open(?: Virtual serial)?|Close session)$/,
    }),
  ).toBeDisabled();
  for (const name of ["Send", "Send file", "New view"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(draft).toBeEditable();
  await expect(draft).toHaveValue("");
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await draft.fill("CAPTURE UNBOUND SAVED");
  const saveCaptureDraft = sender.getByRole("button", {
    name: "Save drafts",
    exact: true,
  });
  await saveCaptureDraft.focus();
  await saveCaptureDraft.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) =>
            s.drafts.unconnected === "CAPTURE UNBOUND SAVED" &&
            s.drafts["session-session"] === "DEVICE EDIT KEPT",
        ),
      ),
    )
    .toBe(true);
  const persistedDrafts = await page.evaluate(
    () => window.workbenchFixture.clientStateWrites.at(-1)?.drafts,
  );
  expect(Object.keys(persistedDrafts ?? {}).sort()).toEqual([
    "session-session",
    "unconnected",
  ]);
  await expect(panel(page)).toContainText("reader_overflow");
  const informationTrigger = panel(page).getByRole("button", {
    name: "Recording · Expand",
    exact: true,
  });
  for (const viewport of [
    { width: 1120, height: 744 },
    { width: 880, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await informationTrigger.focus();
    await informationTrigger.press("Enter");
    const information = page.getByRole("dialog", {
      name: "Recording",
      exact: true,
    });
    await expect(information).toBeVisible();
    await expectReadableBody(`information-open-${viewport.width}`, false);
    await expect(information).toContainText(
      "Verified prefix of a partial recording",
    );
    await expect(information).toContainText(/unknown-write.*unknown/);
    await expect(information).toContainText("Large record summary #44");
    await expect(information).toContainText("999999");
    await expect(information).toContainText("d".repeat(64));
    await expect(information).toContainText("a".repeat(64));
    await expect(information).toContainText("First displayed record: 41");
    for (const name of ["Container complete", "Source continuous"])
      await expect(
        information
          .getByText(name, { exact: true })
          .locator("..")
          .locator("dd"),
      ).toHaveText("No");
    const sources = information
      .locator("summary")
      .filter({ hasText: "Recorded sources" });
    await sources.focus();
    await sources.press("Enter");
    await expect(sources.locator("..")).toHaveAttribute("open", "");
    await expect(information).toContainText(
      "original-host @ 9 / old-device @ 7",
    );
    const largeRecord = information.getByText(/Large record summary #44/);
    await largeRecord.scrollIntoViewIfNeeded();
    await expect(largeRecord).toBeInViewport({ ratio: 1 });
    await writeFile(
      info.outputPath(`information-scroll-${viewport.width}.json`),
      JSON.stringify(
        await information.evaluate((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          pageScroll: scrollY,
          pageWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        })),
        null,
        2,
      ),
    );
    await page.screenshot({
      path: info.outputPath(`recording-information-${viewport.width}.png`),
    });
    await information.press("Escape");
    await expect(information).toHaveCount(0);
    await expect(informationTrigger).toBeFocused();
    await expectReadableBody(`information-closed-${viewport.width}`, false);
    await expect(informationTrigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1120, height: 744 });
  await captureEvidence(page, info, "readonly-saved-tail-1120");
  await deviceTab.click();
  await expect(draft).toHaveValue("DEVICE EDIT KEPT");
  await recording(page, 2).click();
  await expect(draft).toHaveValue("CAPTURE UNBOUND SAVED");
  await expect(draft).toBeEditable();
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  await expect(recording(page, 2)).toHaveCount(0);
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Save current layout", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.workspaceWrites.length),
    )
    .toBe(1);
  const saved = await page.evaluate(
    () => window.workbenchFixture.workspaceWrites[0],
  );
  expect(saved?.captures).toEqual([refA]);
  expect(saved?.views).toHaveLength(1);
  expect(saved?.views[0]?.id).toBe("session-session");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual(["device"]);
  await page.reload();
  await expect(recording(page, 1)).toBeVisible();
  await expect(recording(page, 2)).toHaveCount(0);
  await recording(page, 1).click();
  await expect(panel(page)).toContainText("SAVED_A_BODY");
  await expect(draft).toHaveValue("CAPTURE UNBOUND SAVED");
  await expect(draft).toBeEditable();
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await page.getByRole("tab", { name: "Virtual serial", exact: true }).click();
  await expect(draft).toHaveValue("DEVICE EDIT KEPT");
  await recording(page, 1).click();
  await expect(draft).toHaveValue("CAPTURE UNBOUND SAVED");
  const calls = await page.evaluate(
    () => window.workbenchFixture.captureTailRequests,
  );
  expect(
    calls.some(
      (c) => JSON.stringify(c.query.params.captureRef) === JSON.stringify(refA),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  await captureEvidence(page, info, "explicit-ref-reopened-1120");
});

test("permission loss hides delivered and late recording bodies until a fresh allowed Raw read", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  const late = tail(refA, "LATE_DENIED_BODY");
  const fresh = tail(refA, "FRESH_ALLOWED_BODY");
  await seedWorkbenchFixture(page, {
    theme: "dark",
    workspace: { ...workspace, captures: [refA] },
    captureTails: { results: { [refA.id]: late }, deferred: [refA.id] },
  });
  await page.goto("./#/");
  await expect(recording(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.captureTailRequests.length),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    window.workbenchFixture.setCapturePermission("deny"),
  );
  await expect(panel(page)).toContainText(
    "Recording content requires permission",
  );
  await page.evaluate(
    (id) => window.workbenchFixture.releaseCaptureTail(id),
    refA.id,
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.captureTailResponses.length),
    )
    .toBeGreaterThan(0);
  await waitAnotherPermissionObservation(page);
  await expect(page.locator("body")).not.toContainText("LATE_DENIED_BODY");
  await page.evaluate(
    (payload: string) => {
      const { id, result } = JSON.parse(payload) as {
        id: string;
        result: CaptureTailResult;
      };
      window.workbenchFixture.captureTailResults[id] = result;
      window.workbenchFixture.setCapturePermission("allow");
    },
    JSON.stringify({ id: refA.id, result: fresh }),
  );
  await expect(panel(page)).toContainText("FRESH_ALLOWED_BODY");
  await page.evaluate(() =>
    window.workbenchFixture.setCapturePermission("unknown"),
  );
  await expect(panel(page)).toContainText(
    "Recording content requires permission",
  );
  await expect(page.locator("body")).not.toContainText("FRESH_ALLOWED_BODY");
  await captureEvidence(page, info, "permission-hidden-recording-880");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(
    await page.evaluate(() => window.workbenchFixture.filePickerCalls),
  ).toEqual([]);
});

test("workspace replacement and Host failure exclude late tail bodies without discarding local drafts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 880, height: 600 });
  const other: WorkspaceDocument = {
    ...workspace,
    name: "Other saved recordings",
    captures: [refB],
  };
  await seedWorkbenchFixture(page, {
    workspace: { ...workspace, captures: [refA] },
    drafts: { unconnected: "LOCAL BEFORE SWITCH" },
    captureTails: {
      results: {
        [refA.id]: tail(refA, "LATE_OLD_WORKSPACE"),
        [refB.id]: tail(refB, "CURRENT_WORKSPACE_BODY"),
      },
      deferred: [refA.id],
      workspaces: { other },
    },
  });
  await page.goto("./#/");
  await expect(
    page.getByRole("button", { name: "Saved recordings", exact: true }),
  ).toBeVisible();
  await recording(page, 1).click();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toBeEditable();
  await expect(draft).toHaveValue("LOCAL BEFORE SWITCH");
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await draft.fill("LOCAL EDIT BEFORE SWITCH");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts.unconnected === "LOCAL EDIT BEFORE SWITCH",
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.captureTailRequests.length),
    )
    .toBeGreaterThan(0);
  const dialog = await openTool(page, "Workspace");
  await dialog
    .getByRole("textbox", { name: "Workspace ID", exact: true })
    .fill("other");
  await dialog
    .getByRole("button", { name: "Load workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Other saved recordings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await recording(page, 1).click();
  await expect(panel(page)).toContainText("CURRENT_WORKSPACE_BODY");
  await expect(draft).toHaveValue("LOCAL EDIT BEFORE SWITCH");
  await draft.fill("LOCAL EDIT IN OTHER WORKSPACE");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts.unconnected === "LOCAL EDIT IN OTHER WORKSPACE",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(
    (id) => window.workbenchFixture.releaseCaptureTail(id),
    refA.id,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.captureTailResponses.includes("recording-a"),
      ),
    )
    .toBe(true);
  await waitAnotherPermissionObservation(page);
  await expect(panel(page)).toContainText("CURRENT_WORKSPACE_BODY");
  await expect(page.locator("body")).not.toContainText("LATE_OLD_WORKSPACE");
  await page.evaluate((id) => {
    window.workbenchFixture.holdCaptureTail(id);
    window.workbenchFixture.setCapturePermission("deny");
  }, refB.id);
  await expect(panel(page)).toContainText(
    "Recording content requires permission",
  );
  const before = await page.evaluate(
    () =>
      window.workbenchFixture.captureTailRequests.filter(
        (c) => c.query.target.id === "recording-b",
      ).length,
  );
  await page.evaluate(() =>
    window.workbenchFixture.setCapturePermission("allow"),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.captureTailRequests.filter(
            (c) => c.query.target.id === "recording-b",
          ).length,
      ),
    )
    .toBeGreaterThan(before);
  await page.evaluate(() => window.workbenchFixture.failRefresh());
  const diagnostics = await openTool(page, "Troubleshooting");
  await diagnostics
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await diagnostics.press("Escape");
  await expect(diagnostics).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({
      hasText: "The local service could not connect. Please retry.",
    }),
  ).toBeVisible();
  const deliveredBeforeLoss = await page.evaluate(
    () =>
      window.workbenchFixture.captureTailResponses.filter(
        (id) => id === "recording-b",
      ).length,
  );
  await page.evaluate(
    (id) => window.workbenchFixture.releaseCaptureTail(id),
    refB.id,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.captureTailResponses.filter(
            (id) => id === "recording-b",
          ).length,
      ),
    )
    .toBeGreaterThan(deliveredBeforeLoss);
  await expect(page.locator("body")).not.toContainText(
    "CURRENT_WORKSPACE_BODY",
  );
  await expect(page.locator("body")).not.toContainText("LATE_OLD_WORKSPACE");
  await expect(draft).toHaveValue("LOCAL EDIT IN OTHER WORKSPACE");
  await expect(draft).toBeEditable();
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await draft.fill("OFFLINE UNBOUND SAVED");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some(
          (s) => s.drafts.unconnected === "OFFLINE UNBOUND SAVED",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Send draft", exact: true }),
  ).toHaveValue("OFFLINE UNBOUND SAVED");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await captureEvidence(
    page,
    info,
    "host-failed-tail-hidden-draft-retained-880",
  );
  await page.reload();
  await expect(draft).toHaveValue("OFFLINE UNBOUND SAVED");
  await recording(page, 1).click();
  await expect(draft).toHaveValue("OFFLINE UNBOUND SAVED");
  await expect(draft).toBeEditable();
  await expect(draft).toHaveAccessibleDescription("Unconnected draft");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});
