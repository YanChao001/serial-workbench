import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { builtinAutomation } from "./json-fixtures";
import { builtinCommandSequenceAction } from "../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";

const action = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === builtinCommandSequenceAction,
);
if (!validateActionSpec(action))
  throw new Error("Missing built-in command-sequence action");

async function selectSerial(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
}

async function openSequence(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Command sequence", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Command sequence", exact: true });
}

test("command sequence previews configured branches and submits the current cursor only when run", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  const run = dialog.getByRole("button", { name: "Run sequence" });
  await expect(run).toBeDisabled();
  await dialog.getByRole("button", { name: "Load example" }).click();
  const editor = dialog.getByRole("textbox", {
    name: "Sequence definition (JSON)",
  });
  const definition = await editor.inputValue();
  await expect(dialog.getByText(/Destination Virtual serial/)).toBeVisible();
  await expect(dialog.getByText("Send 41", { exact: true })).toBeVisible();
  await dialog.getByText("On timeout, then stop", { exact: true }).click();
  await expect(dialog.getByText("Send 58", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Wait 100 ms", { exact: true })).toBeVisible();

  await editor.fill("{}");
  await expect(run).toBeDisabled();
  await expect(
    dialog.getByText("Check the definition at $.version."),
  ).toBeVisible();
  await editor.fill(definition);
  await editor.press("End");
  await editor.press("Enter");
  await expect(run).toBeEnabled();
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinCommandSequenceAction,
    ),
  ).toBe(0);
  const edited = await editor.inputValue();
  await dialog.getByRole("button", { name: "Save JSON" }).click();
  expect(
    await page.evaluate(() => window.workbenchFixture.savedTextExports),
  ).toEqual([{ name: "command-sequence.json", content: edited }]);
  await page.evaluate(() => {
    window.workbenchFixture.automationCursorPosition = "41";
  });
  await run.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Command sequence completed.",
  );
  const calls = await page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter(
        (call) => call.actionId === id,
      ),
    builtinCommandSequenceAction,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    executionMode: "independent",
    target: { sessionId: "session", sessionEpoch: "1" },
    params: { definition: edited, startEventSeq: "42" },
  });
  await dialog.getByText("Write receipts", { exact: true }).click();
  await expect(dialog.getByText("RX bytes [0, 1)")).toBeVisible();
});

test("command sequence imports a definition and recovers an accepted task until Host actually stops it", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "held" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  await dialog.locator("input[type=file]").setInputFiles({
    name: "sequence.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1,"steps":[{"kind":"send","hex":"AA"}]}'),
  });
  await dialog.getByRole("button", { name: "Run sequence" }).click();
  await expect(dialog.getByRole("status")).toContainText("Completed steps 1");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openSequence(page);
  await dialog.getByRole("button", { name: "Stop sequence" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Waiting for Host to stop the task",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-sequence",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinCommandSequenceAction,
    ),
  ).toBe(1);
});

test("command sequence uses Host authorization before admitting any send", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "denied" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  await dialog.getByRole("button", { name: "Load example" }).click();
  await dialog.getByRole("button", { name: "Run sequence" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    /not authorized|permissions/i,
  );
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinCommandSequenceAction,
    ),
  ).toBe(0);
});

test("command sequence leaves an edited draft intact after an empty or invalid import", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  const editor = dialog.getByRole("textbox", {
    name: "Sequence definition (JSON)",
  });
  const draft = '{"version":1,"steps":[{"kind":"send","hex":"A1"}]}';
  await editor.fill(draft);

  const empty = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Open JSON" }).click();
  await (await empty).setFiles([]);
  await expect(editor).toHaveValue(draft);

  const invalid = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Open JSON" }).click();
  await (
    await invalid
  ).setFiles({
    name: "future.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":2,"steps":[]}'),
  });
  await expect(dialog.getByRole("alert")).toContainText("$.version");
  await expect(editor).toHaveValue(draft);
});

test("a transient status read failure leaves task observation and stopping available", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "held" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  await page.evaluate(() => {
    window.workbenchFixture.automationObserveFailures = 1;
  });
  await dialog.getByRole("button", { name: "Load example" }).click();
  await dialog.getByRole("button", { name: "Run sequence" }).click();

  const stop = dialog.getByRole("button", { name: "Stop sequence" });
  const retry = dialog.getByRole("button", { name: "Check task again" });
  await expect(retry).toBeVisible();
  await expect(stop).toBeEnabled();
  await retry.click();
  await expect(retry).toBeHidden();
  await expect(dialog.getByRole("status")).toContainText("Completed steps 1");
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
            call.target.id === "fixture-sequence",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
});

test("a cursor for another Raw scope cannot start a sequence", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  await page.evaluate(() => {
    window.workbenchFixture.automationCursorScope = "raw:other:1";
  });
  await dialog.getByRole("button", { name: "Load example" }).click();
  await dialog.getByRole("button", { name: "Run sequence" }).click();
  await expect(dialog.getByRole("status")).not.toBeEmpty();
  await expect(
    dialog.getByRole("button", { name: "Run sequence" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinCommandSequenceAction,
    ),
  ).toBe(0);
});
