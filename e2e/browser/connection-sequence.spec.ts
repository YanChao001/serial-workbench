import { expect, test } from "@playwright/test";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import { builtinConnectionSequenceAction } from "../../packages/plugin-sdk/examples/reference-automation/connection-sequence-model";
import { builtinAutomation } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const action = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === builtinConnectionSequenceAction,
);
if (!validateActionSpec(action))
  throw new Error("Missing built-in connection sequence action");

test("connection parameters can preview, confirm and reopen one ordered startup task", async ({
  page,
}, info) => {
  const hostId = "workbench-gui-host";
  const connectionReport = {
    outcome: "completed",
    session: {
      hostId,
      kind: "session",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
    steps: [
      { kind: "before_open", state: "succeeded" },
      { kind: "open", state: "succeeded", operationId: "open" },
      { kind: "send", state: "succeeded", operationId: "wake" },
      {
        kind: "ready",
        state: "succeeded",
        source: {
          hostId,
          sessionId: "session",
          sessionEpoch: "1",
          direction: "rx",
          eventStart: "3",
          eventEnd: "4",
          byteStart: "0",
          byteEnd: "2",
        },
      },
    ],
  };
  await page.setViewportSize({ width: 420, height: 680 });
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    automation: { action, state: "ready", connectionReport },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Connection parameters", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Connection parameters", exact: true })
    .getByRole("button", { name: "Connection sequence", exact: true })
    .click();

  const tool = page.getByRole("dialog", { name: "Connection sequence" });
  const start = tool.getByRole("button", { name: "Open and run" });
  const add = tool.getByRole("button", { name: "Add step" });
  await expect(tool.getByText("Virtual serial", { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await tool
    .getByRole("textbox", { name: "Wait before opening (ms)" })
    .fill("100");
  await add.click();
  await tool.getByRole("combobox", { name: "Step 1", exact: true }).click();
  await page
    .getByRole("option", { name: "Send wake bytes", exact: true })
    .click();
  const wake = tool.getByRole("textbox", { name: "HEX bytes" }).first();
  await wake.fill("A!");
  await expect(start).toBeDisabled();
  await wake.fill("a5");
  await expect(tool.getByText("A5", { exact: true })).toBeVisible();

  await add.click();
  await tool.getByRole("combobox", { name: "Step 2", exact: true }).click();
  await page
    .getByRole("option", { name: "Wait for ready bytes", exact: true })
    .click();
  await tool.getByRole("textbox", { name: "HEX bytes" }).last().fill("4f 4b");
  await expect(tool.getByText("4F 4B", { exact: true })).toBeVisible();
  await expect(start).toBeEnabled();

  const invocations = () =>
    page.evaluate(
      (actionId) =>
        window.workbenchFixture.invocations.filter(
          (value) => value.actionId === actionId,
        ),
      builtinConnectionSequenceAction,
    );
  expect(await invocations()).toEqual([]);
  await page.screenshot({
    path: info.outputPath("connection-sequence-narrow.png"),
  });
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.screenshot({
    path: info.outputPath("connection-sequence-wide.png"),
  });

  await start.click();
  const receipts = tool.getByRole("region", { name: "Step receipts" });
  await expect(
    receipts.getByText("Connection sequence completed."),
  ).toBeVisible();
  await expect(receipts.getByText(/RX \[0, 2\)/)).toBeVisible();
  expect(await invocations()).toEqual([
    expect.objectContaining({
      actionId: builtinConnectionSequenceAction,
      executionMode: "independent",
      target: expect.objectContaining({ hostId, kind: "device" }),
      params: expect.objectContaining({
        definition: {
          version: 1,
          beforeOpenMs: 100,
          steps: [
            { kind: "send", bytesBase64: "pQ==" },
            { kind: "ready", bytesBase64: "T0s=", timeoutMs: 1000 },
          ],
        },
      }),
    }),
  ]);

  await page.keyboard.press("Escape");
  await expect(tool).toBeHidden();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Connection sequence", exact: true })
    .click();
  await expect(
    receipts.getByText("Connection sequence completed."),
  ).toBeVisible();
  expect(await invocations()).toHaveLength(1);
  await tool.getByRole("button", { name: "Show session", exact: true }).click();
  await expect(tool).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  expect(await invocations()).toHaveLength(1);
});
