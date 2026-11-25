import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
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
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.savedTextExports))
    .toEqual([{ name: "command-sequence.json", content: edited }]);
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

test("closing a sequence drops a late binary input read and leaves its file reference unbound", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  await selectSerial(page);
  const dialog = await openSequence(page);
  const referenced = {
    version: 1,
    variables: { fixture_bytes: null },
    steps: [{ kind: "send", hex: "$" + "{fixture_bytes}" }],
  };
  const referenceFile = {
    name: "reference.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(referenced)),
  };
  await dialog.locator("input[type=file][accept]").setInputFiles(referenceFile);
  const value = dialog.getByLabel("fixture_bytes", { exact: true });
  await expect(value).toHaveValue("");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === "delayed-reference.bin") {
        document.documentElement.dataset.sequenceRead = "waiting";
        await new Promise<void>((resolve) => {
          document.addEventListener(
            "test-sequence-release-file",
            () => resolve(),
            { once: true },
          );
        });
        File.prototype.arrayBuffer = read;
        const bytes = await read.call(this);
        document.documentElement.dataset.sequenceRead = "released";
        return bytes;
      }
      return read.call(this);
    };
  });
  const choose = dialog.getByRole("button", {
    name: "Choose file for fixture_bytes",
  });
  const picked = page.waitForEvent("filechooser");
  await choose.click();
  await (
    await picked
  ).setFiles({
    name: "delayed-reference.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 255]),
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-sequence-read",
    "waiting",
  );
  await expect(
    dialog.getByRole("button", { name: "Run sequence" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Close view" }).click();
  await expect(dialog).toBeHidden();
  const reopened = await openSequence(page);
  await reopened
    .locator("input[type=file][accept]")
    .setInputFiles(referenceFile);
  await expect(
    reopened.getByLabel("fixture_bytes", { exact: true }),
  ).toHaveValue("");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test-sequence-release-file")),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-sequence-read",
    "released",
  );
  await expect(
    reopened.getByLabel("fixture_bytes", { exact: true }),
  ).toHaveValue("");
  await expect(
    reopened.getByRole("button", { name: "Run sequence" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          ({ actionId }) => actionId === id,
        ),
      builtinCommandSequenceAction,
    ),
  ).toHaveLength(0);
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

test("records composer bytes and confirmed receive selections, then replays only when asked", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready" },
    manualSendReceipts: true,
  });
  await selectSerial(page);
  const composer = page.getByRole("region", { name: "Send", exact: true });
  const recorder = composer.getByRole("button", {
    name: "Record manual sends",
    exact: true,
  });
  const draft = composer.getByRole("textbox", { name: "Send draft" });
  const send = composer.getByRole("button", { name: "Send", exact: true });
  await recorder.click();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await draft.fill("A");
  await send.click();
  await recorder.click();
  await expect(page.getByText("Confirmed sends: 1.")).toBeVisible();
  await recorder.press("Escape");
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  const log = terminal.getByRole("log");
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    workbenchStreamItems().filter(
      (item) => item.kind === "source" && item.event.kind === "rx",
    ) as unknown[],
  );
  const hex = log.locator("[data-direction=rx] [data-hex-source]");
  await expect(hex).toHaveText("4F 4B 0D 0A");
  const preview = page.getByRole("dialog", { name: "Preview send selection" });
  async function previewSelection() {
    await hex.evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error("Missing RX bytes");
      document.getSelection()?.setBaseAndExtent(text, 0, text, 5);
    });
    await log.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Preview send selection" })
      .click();
    await expect(preview.locator("pre")).toHaveText("4F 4B");
  }
  await previewSelection();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(log).toBeFocused();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual([
    "QQ==",
  ]);
  await previewSelection();
  await preview.getByRole("button", { name: "Confirm send" }).click();
  await expect(preview.getByRole("status")).toContainText("manual-tx-2");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(draft).toHaveValue("A");
  const writeWaitMs = await page.evaluate(() =>
    Number(
      window.workbenchFixture.invocations
        .filter(({ actionId }) => actionId === "session.tx")
        .at(-1)?.params.writeWaitMs,
    ),
  );
  await recorder.click();
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(page.getByText("Confirmed sends: 2.")).toBeVisible();
  await page
    .getByRole("button", { name: "Review in command sequence" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Command sequence",
    exact: true,
  });
  const editor = dialog.getByRole("textbox", {
    name: "Sequence definition (JSON)",
  });
  await expect(editor).toBeVisible();
  await expect(dialog.getByText("Send 41", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Send 4F 4B", { exact: true })).toBeVisible();
  const definition = await editor.inputValue();
  expect(JSON.parse(definition)).toMatchObject({
    version: 1,
    steps: [
      { kind: "send", hex: "41", writeWaitMs: 1001 },
      { kind: "delay", milliseconds: expect.any(Number) },
      { kind: "send", hex: "4F 4B", writeWaitMs },
    ],
  });
  expect(
    await page.evaluate(
      (actionId) => ({
        sent: window.workbenchFixture.sentBytes,
        automation: window.workbenchFixture.invocations.filter(
          (call) => call.actionId === actionId,
        ).length,
        saves: window.workbenchFixture.savedTextExports.length,
      }),
      builtinCommandSequenceAction,
    ),
  ).toEqual({ sent: ["QQ==", "T0s="], automation: 0, saves: 0 });
  await dialog.getByRole("button", { name: "Run sequence" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Command sequence completed.",
  );
  expect(
    await page.evaluate(
      (actionId) =>
        window.workbenchFixture.invocations.find(
          (call) => call.actionId === actionId,
        )?.params,
      builtinCommandSequenceAction,
    ),
  ).toMatchObject({ definition });
});

test("a stale session revision cannot add a write to the previous recording", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready" },
    manualSendReceipts: true,
  });
  await selectSerial(page);
  const composer = page.getByRole("region", { name: "Send", exact: true });
  const recorder = composer.getByRole("button", {
    name: "Record manual sends",
    exact: true,
  });
  const draft = composer.getByRole("textbox", { name: "Send draft" });
  const send = composer.getByRole("button", { name: "Send", exact: true });
  await recorder.click();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await draft.fill("A");
  await send.click();
  await recorder.click();
  await expect(page.getByText("Confirmed sends: 1.")).toBeVisible();
  await recorder.press("Escape");

  await page.evaluate(() => {
    window.workbenchFixture.manualSendRevision = "2";
  });
  await draft.fill("B");
  await send.click();
  await recorder.click();
  await expect(
    page.getByText(/A write lacks a complete receipt/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review in command sequence" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Command sequence",
    exact: true,
  });
  await expect(dialog.getByText("Send 41", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Send 42", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual([
    "QQ==",
  ]);
});

test("command sequence previews safe retry frames and shows both Host receipts", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready", sequenceRetry: true },
  });
  await selectSerial(page);
  const dialog = await openSequence(page);
  const editor = dialog.getByRole("textbox", {
    name: "Sequence definition (JSON)",
  });
  const run = dialog.getByRole("button", { name: "Run sequence" });
  const definition = (expectHex: string) =>
    JSON.stringify({
      version: 1,
      steps: [
        {
          kind: "send",
          hex: "53",
          expect: {
            hex: "A4",
            timeoutMs: 100,
            retry: [{ hex: "54", expectHex }],
          },
        },
      ],
    });
  await editor.fill(definition("A4"));
  await expect(
    dialog.getByText(
      "Check the definition at $.steps[0].expect.retry[0].expectHex.",
    ),
  ).toBeVisible();
  await expect(run).toBeDisabled();
  await editor.fill(definition("A5"));
  await expect(
    dialog.getByText("Retry after confirmed write and response timeout"),
  ).toBeVisible();
  await expect(
    dialog.getByText("Send 54 · Expect A5", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ).length,
      builtinCommandSequenceAction,
    ),
  ).toBe(0);
  await run.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Command sequence completed.",
  );
  await dialog.getByText("Write receipts", { exact: true }).click();
  await expect(
    dialog.getByText("sequence-tx-1", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("$.steps[0].expect.retry[0]", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("sequence-tx-2", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("RX bytes [0, 1)", { exact: true }),
  ).toBeVisible();
});

test("an unbound send can preview retries before its actual bytes are validated", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready", sequenceRetry: true },
  });
  await selectSerial(page);
  const dialog = await openSequence(page);
  const run = dialog.getByRole("button", { name: "Run sequence" });
  const definition = {
    version: 1,
    variables: { payload: null, zero: " 00 " },
    steps: [
      {
        kind: "send",
        hex: "$" + "{payload}",
        expect: {
          hex: "A4",
          timeoutMs: 100,
          retry: [
            { hex: "$" + "{zero}", expectHex: "A5" },
            { hex: "01", expectHex: "A6" },
            { hex: "02", expectHex: "A7" },
          ],
        },
      },
    ],
  };
  await dialog.locator("input[type=file][accept]").setInputFiles({
    name: "referenced-retry.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(
    dialog.getByText("Send input payload", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Send 00 · Expect A5", { exact: true }),
  ).toBeVisible();
  await expect(run).toBeDisabled();

  const file = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose file for payload" }).click();
  await (
    await file
  ).setFiles({
    name: "conflicting-retry.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0]),
  });
  await expect(
    dialog.getByText(
      "Check HEX and sequence limits at $.steps[0].expect.retry[0].hex.",
    ),
  ).toBeVisible();
  await expect(run).toBeDisabled();
  const calls = () =>
    page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          ({ actionId }) => actionId === id,
        ),
      builtinCommandSequenceAction,
    );
  expect(await calls()).toHaveLength(0);

  await dialog.getByLabel("payload", { exact: true }).fill("FF");
  await expect(run).toBeEnabled();
  await expect(
    dialog.getByText("Send input payload", { exact: true }),
  ).toBeVisible();
  await run.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Command sequence completed.",
  );
  const dispatched = await calls();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.params.definition).toBe(
    JSON.stringify({
      ...definition,
      variables: { zero: " 00 ", payload: "FF" },
    }),
  );
});
