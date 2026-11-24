import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { builtinAutomation, referenceAutomation } from "./json-fixtures";
import {
  builtinRepeatSendAction,
  repeatSendAction,
} from "../../packages/plugin-sdk/examples/reference-automation/repeat-send-settings";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";

const action = referenceAutomation.contributes.actions.find(
  (entry) => entry.actionId === repeatSendAction,
);
if (!validateActionSpec(action))
  throw new Error("Missing reference automation action");
const builtinAction = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === builtinRepeatSendAction,
);
if (!validateActionSpec(builtinAction))
  throw new Error("Missing built-in signed automation action");

async function openSchedule(page: Page) {
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Scheduled send", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Scheduled send", exact: true });
}

async function openVirtualSerial(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
}

test("scheduled send previews the full draft and submits explicit independent Host work", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    repeatSend: { action: builtinAction, state: "ready" },
  });
  await openVirtualSerial(page);
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await draft.fill("PING");
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("button", { name: "Use bytes from send draft" })
    .click();
  await expect(
    dialog.getByText(/Destination Virtual serial · session generation 1/),
  ).toBeVisible();
  const send = dialog.getByRole("textbox", { name: "Bytes to send (HEX)" });
  await expect(send).toHaveValue("50 49 4E 47");
  await send.press("Enter");
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinRepeatSendAction,
    ),
  ).toBe(0);

  const start = dialog.getByRole("button", { name: "Start scheduled send" });
  await dialog
    .getByRole("spinbutton", { name: "Period (ms)", exact: true })
    .fill("0");
  await expect(start).toBeDisabled();
  await dialog
    .getByRole("spinbutton", { name: "Period (ms)", exact: true })
    .fill("250");
  await dialog.getByRole("spinbutton", { name: "Number of rounds" }).fill("2");
  await dialog
    .getByText("Delay, jitter and receive conditions", { exact: true })
    .click();
  await dialog.getByRole("spinbutton", { name: "Jitter (± ms)" }).fill("8");
  await dialog
    .getByRole("textbox", { name: "Expected reply after each send (HEX)" })
    .fill("4F 4B");
  await expect(
    dialog.getByText("4 bytes per round", { exact: true }),
  ).toBeVisible();
  await start.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Scheduled send completed.",
  );
  await expect(dialog.getByRole("status")).toContainText(
    "2 confirmed rounds, 0 missed slots",
  );
  const calls = await page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter(
        (call) => call.actionId === id,
      ),
    builtinRepeatSendAction,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    executionMode: "independent",
    target: { id: "session", sessionId: "session", sessionEpoch: "1" },
    params: {
      sendBase64: "UElORw==",
      periodMs: 250,
      count: 2,
      jitterMs: 8,
      expectBase64: "T0s=",
    },
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(draft).toHaveValue("PING");
});

test("scheduled send recovers the accepted task on reopening and waits for actual cancellation", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { repeatSend: { action, state: "held" } });
  await openVirtualSerial(page);
  const dialog = await openSchedule(page);
  await dialog
    .getByRole("textbox", { name: "Bytes to send (HEX)" })
    .fill("00 FF");
  await dialog.getByRole("button", { name: "Start scheduled send" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "1 of 5 rounds confirmed",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await openSchedule(page);
  const stop = dialog.getByRole("button", { name: "Stop scheduled send" });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Waiting for Host to stop the task",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-repeat",
        ),
      ),
    )
    .toBe(true);
  await expect(dialog.getByRole("status")).not.toContainText(
    "Host confirmed that the task stopped.",
  );
  await page.evaluate(() => window.workbenchFixture.finishRepeatCancellation());
  await expect(dialog.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      repeatSendAction,
    ),
  ).toBe(1);
});

test("scheduled send leaves device admission untouched when the selected actor is denied", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { repeatSend: { action, state: "denied" } });
  await openVirtualSerial(page);
  const dialog = await openSchedule(page);
  await dialog.getByRole("textbox", { name: "Bytes to send (HEX)" }).fill("AA");
  await dialog.getByRole("button", { name: "Start scheduled send" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    /not authorized|permissions/i,
  );
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      repeatSendAction,
    ),
  ).toBe(0);
});
