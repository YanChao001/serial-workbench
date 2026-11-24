import { expect, test, type Page } from "@playwright/test";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import {
  builtinCalendarTaskAction,
  calendarTaskAction,
} from "../../packages/plugin-sdk/examples/reference-automation/calendar-settings";
import { builtinAutomation, referenceAutomation } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const action = builtinAutomation.contributes.actions.find(
  ({ actionId }) => actionId === builtinCalendarTaskAction,
);
const reference = referenceAutomation.contributes.actions.find(
  ({ actionId }) => actionId === calendarTaskAction,
);
if (!validateActionSpec(action) || !validateActionSpec(reference))
  throw new Error("Missing a calendar schedule action");

async function openSchedule(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Calendar schedule", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Calendar schedule", exact: true });
}

async function openSession(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
}

const once = "2026-12-31T08:30:00+08:00";
const end = "2026-12-31T10:00:00+08:00";

test("a signed calendar plan previews an explicit UTC instant and submits on user confirmation", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await openSession(page);
  await page
    .getByRole("textbox", { name: "Send draft", exact: true })
    .fill("CAL");
  const dialog = await openSchedule(page);
  const at = dialog.getByRole("textbox", { name: "Run at (with UTC offset)" });
  const arm = dialog.getByRole("button", { name: "Arm schedule" });
  await dialog
    .getByRole("button", { name: "Use bytes from send draft" })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }),
  ).toHaveValue("43 41 4C");
  await at.fill("2026-02-31T08:30:00+08:00");
  await expect(arm).toBeDisabled();
  await at.fill(once);
  await expect(
    dialog.getByText("2026-12-31T00:30:00.000Z · 3 bytes", { exact: true }),
  ).toBeVisible();
  await at.press("Enter");
  expect(await invocationCount(page, builtinCalendarTaskAction)).toBe(0);
  await arm.click();

  await expect(dialog.getByRole("status")).toContainText(
    "Calendar schedule completed.",
  );
  await dialog.getByText("Schedule receipts", { exact: true }).click();
  await expect(
    dialog.getByText(/calendar-tx-1 · Write confirmed/),
  ).toBeVisible();
  const observed = await page.evaluate(
    (id) => ({
      invocation: window.workbenchFixture.invocations.find(
        (call) => call.actionId === id,
      ),
      revision: window.workbenchFixture.manualSendRevision,
    }),
    builtinCalendarTaskAction,
  );
  expect(observed.invocation).toMatchObject({
    executionMode: "independent",
    target: { hostId: "workbench-gui-host", sessionEpoch: "1" },
    params: {
      schedule: { kind: "once", at: once },
      sessionRevision: observed.revision,
      bytesBase64: "Q0FM",
    },
  });
});

test("a cron plan survives panel close and stops by its accepted operation ID", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    automation: { action: reference, state: "held" },
    sendHistory: true,
  });
  await openSession(page);
  const dialog = await openSchedule(page);
  await dialog.getByRole("button", { name: "Repeat with cron" }).click();
  const expression = dialog.getByRole("textbox", { name: "Cron expression" });
  const timeZone = dialog.getByRole("textbox", { name: "IANA time zone" });
  await page.setViewportSize({ width: 1240, height: 800 });
  const wideExpression = await expression.boundingBox();
  const wideZone = await timeZone.boundingBox();
  if (!wideExpression || !wideZone)
    throw new Error("Missing wide cron field geometry");
  expect(wideZone.y).toBe(wideExpression.y);
  expect(wideZone.x).toBeGreaterThan(wideExpression.x + wideExpression.width);
  await page.setViewportSize({ width: 440, height: 650 });
  const narrowExpression = await expression.boundingBox();
  const narrowZone = await timeZone.boundingBox();
  if (!narrowExpression || !narrowZone)
    throw new Error("Missing narrow cron field geometry");
  expect(narrowZone.x).toBe(narrowExpression.x);
  expect(narrowZone.y).toBeGreaterThanOrEqual(
    narrowExpression.y + narrowExpression.height,
  );
  await dialog
    .getByRole("textbox", { name: "Cron expression" })
    .fill("15 8 * * MON-FRI");
  await dialog
    .getByRole("textbox", { name: "IANA time zone" })
    .fill("Asia/Shanghai");
  await dialog
    .getByRole("textbox", { name: "End at (with UTC offset)" })
    .fill(end);
  await dialog.getByRole("spinbutton", { name: "Maximum attempts" }).fill("2");
  await dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }).fill("FF");
  await dialog.getByRole("button", { name: "Arm schedule" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "The schedule is armed on the Host.",
  );
  const status = dialog.getByRole("status");
  await expect(status).toBeInViewport();
  await status.screenshot({
    path: info.outputPath("calendar-narrow-status.png"),
  });
  await page.setViewportSize({ width: 1240, height: 800 });
  await dialog.screenshot({ path: info.outputPath("calendar-wide.png") });
  await page.setViewportSize({ width: 440, height: 650 });
  const invocation = await page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.find((call) => call.actionId === id),
    calendarTaskAction,
  );
  expect(invocation?.params).toMatchObject({
    count: 2,
    endAt: end,
    schedule: {
      kind: "cron",
      expression: "15 8 * * MON-FRI",
      timeZone: "Asia/Shanghai",
    },
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => window.workbenchFixture.emitCalendarPeer()),
  ).toBeGreaterThan(0);
  await openSchedule(page);
  await expect(dialog.getByRole("status")).toContainText(
    "Task fixture-calendar",
  );
  await dialog.getByRole("button", { name: "Stop schedule" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-calendar",
        ),
      ),
    )
    .toBe(true);
  await expect(dialog.getByRole("status")).not.toContainText(
    "Host confirmed that the task stopped.",
  );
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
  expect(await invocationCount(page, calendarTaskAction)).toBe(1);
});

test("a changed authoritative session revision blocks schedule admission", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await openSession(page);
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("textbox", { name: "Run at (with UTC offset)" })
    .fill(once);
  await dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }).fill("AA");
  await page.evaluate(() => {
    window.workbenchFixture.calendarSessionRevision = "99";
  });
  await dialog.getByRole("button", { name: "Arm schedule" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/changed|revision/i);
  expect(await invocationCount(page, builtinCalendarTaskAction)).toBe(0);
});

async function invocationCount(page: Page, actionId: string) {
  return page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter((call) => call.actionId === id)
        .length,
    actionId,
  );
}

test("an accepted schedule waits for Host arming progress", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "held", calendarInitiallyQueued: true },
  });
  await openSession(page);
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("textbox", { name: "Run at (with UTC offset)" })
    .fill(once);
  await dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }).fill("01");
  await dialog.getByRole("button", { name: "Arm schedule" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Waiting for the Host to arm the schedule.",
  );
  await expect(dialog.getByRole("status")).not.toContainText(
    "The schedule is armed on the Host.",
  );
  await expect(
    dialog.getByRole("button", { name: "Stop schedule" }),
  ).toBeEnabled();
});

test("a late cancellation error belongs to the previous task", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: {
      action,
      state: "held",
      delayFirstCancellationReply: true,
      delaySecondCalendarCheck: true,
    },
  });
  await openSession(page);
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("textbox", { name: "Run at (with UTC offset)" })
    .fill(once);
  await dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }).fill("02");
  const arm = dialog.getByRole("button", { name: "Arm schedule" });
  await arm.click();
  await expect(dialog.getByRole("status")).toContainText(
    "The schedule is armed on the Host.",
  );
  await dialog.getByRole("button", { name: "Stop schedule" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationCancelReplyHeld),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
  await arm.click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.calendarCheckHeld))
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationCancelReply(),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationCancelReplyHeld),
    )
    .toBe(false);
  await page.evaluate(() => window.workbenchFixture.releaseCalendarCheck());
  await expect(dialog.getByRole("status")).toContainText(
    "Task fixture-calendar-2",
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("an unsubmitted schedule is registered as unsaved work", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await openSession(page);
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("textbox", { name: "Run at (with UTC offset)" })
    .fill(once);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Save unfinished work" }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Calendar schedule" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Run at (with UTC offset)" }),
  ).toHaveValue(once);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard and continue" }).click();
  await expect(dialog).toBeHidden();
  await openSchedule(page);
  await expect(
    dialog.getByRole("textbox", { name: "Run at (with UTC offset)" }),
  ).toHaveValue("");
});
