import { expect, test, type Page } from "@playwright/test";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import { en } from "../../src/i18n/en";
import { builtinAutomation } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const ruleId = "swb.builtin.automation.rule";
const action = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === ruleId,
);
if (!validateActionSpec(action)) throw new Error("Missing signed rule action");

async function openRule(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const dialog = await openRuleMenu(page);
  await dialog
    .getByRole("button", { name: "Load example", exact: true })
    .click();
  return dialog;
}

async function openRuleMenu(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Rule triggers", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Rule triggers", exact: true });
}

function invocations(page: Page) {
  return page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter(
        (item) => item.actionId === id,
      ),
    ruleId,
  );
}

test("arms the exact session only on explicit action and shows a verified match notification", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  const dialog = await openRule(page);
  await page.setViewportSize({ width: 440, height: 640 });
  expect(await invocations(page)).toHaveLength(0);
  const editor = dialog.getByRole("textbox", {
    name: en["ruleTrigger.definition"],
  });
  const example = await editor.inputValue();
  await editor.fill("{");
  await expect(editor).toHaveAccessibleDescription(en["ruleTrigger.invalid"]);
  const arm = dialog.getByRole("button", { name: "Arm rule", exact: true });
  await expect(arm).toBeDisabled();
  await editor.fill(example);
  await arm.click();
  const status = dialog.getByRole("status");
  await expect(status).toContainText(
    "Rule matched and returned a notification.",
  );
  await expect(status).toContainText("Bench alert received");
  await expect(status).toContainText("[2, 8)");
  await status.screenshot({ path: info.outputPath("rule-status-narrow.png") });
  const calls = await invocations(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    executionMode: "independent",
    params: { startEventSeq: "1" },
  });
});

test("explains unavailable or incompatible actions and checks current effect permission before arming", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  const dialog = await openRule(page);
  await page.setViewportSize({ width: 420, height: 540 });
  const editor = dialog.getByRole("textbox", {
    name: en["ruleTrigger.definition"],
  });
  const arm = dialog.getByRole("button", { name: "Arm rule", exact: true });
  const base = { version: 1, condition: { kind: "regex", pattern: "^ALARM$" } };
  const fillAction = (actionId: string, params: object = {}) =>
    editor.fill(
      JSON.stringify({
        ...base,
        effect: { kind: "action", actionId, params },
      }),
    );
  await fillAction("workspace.save");
  await expect(editor).toHaveAccessibleDescription(
    "Action workspace.save cannot run in a serial session. Choose a session action.",
  );
  await expect(arm).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: /^(Save|Download) JSON$/ }),
  ).toBeEnabled();
  const unavailable = "example.missing." + "very-long-action-".repeat(5) + "id";
  await fillAction(unavailable);
  await expect(editor).toHaveAccessibleDescription(
    new RegExp(
      "Action " + unavailable.replaceAll(".", "\\.") + " is unavailable",
    ),
  );
  await expect(arm).toBeDisabled();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await fillAction("session.tx");
  await expect(editor).toHaveAccessibleDescription(
    /use the serial write effect/,
  );
  await expect(arm).toBeDisabled();
  await page.evaluate(() => {
    window.workbenchFixture.configureAllowed = false;
  });
  const params = { requested: { baudRate: "19200" } };
  await fillAction("session.configure", params);
  await expect(arm).toBeEnabled();
  await arm.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Permission to run session.configure in this session was denied.",
  );
  await expect(editor).toBeEnabled();
  await expect(editor).toHaveValue(
    JSON.stringify({
      ...base,
      effect: { kind: "action", actionId: "session.configure", params },
    }),
  );
  expect(await invocations(page)).toHaveLength(0);
  const preflight = await page.evaluate(() =>
    window.workbenchFixture.queryInputs.filter(
      ({ actionId, params }) =>
        actionId === "action.check" && params.actionId === "session.configure",
    ),
  );
  expect(preflight.at(-1)).toMatchObject({
    target: { kind: "session", sessionEpoch: "1" },
    params: { actionId: "session.configure", params },
  });
  await fillAction("workspace.save");
  await expect(
    dialog.getByText(/Permission to run session.configure/),
  ).toHaveCount(0);
});

test("keeps an accepted cancellation pending until the Host supplies a terminal receipt", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "held" } });
  const dialog = await openRule(page);
  await dialog.getByRole("button", { name: "Arm rule", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rule armed and waiting for a match.",
  );
  const stop = dialog.getByRole("button", { name: "Stop rule", exact: true });
  await stop.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Waiting for Host to stop",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-rule",
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
  await expect(stop).toBeHidden();
});

test("refuses a stale Raw cursor without submitting a rule", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  const dialog = await openRule(page);
  await page.evaluate(() => {
    window.workbenchFixture.automationCursorScope = "raw:old:1";
  });
  await dialog.getByRole("button", { name: "Arm rule", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Arm rule", exact: true }),
  ).toBeEnabled();
  expect(await invocations(page)).toHaveLength(0);
});

test("a delayed stop reply cannot block stopping a newer rule", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "held", delayFirstCancellationReply: true },
  });
  const dialog = await openRule(page);
  const arm = dialog.getByRole("button", { name: "Arm rule", exact: true });
  const stop = dialog.getByRole("button", { name: "Stop rule", exact: true });
  const status = dialog.getByRole("status");
  await arm.click();
  await stop.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationCancelReplyHeld),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(status).toContainText("Host confirmed that the task stopped.");
  await arm.click();
  await expect(status).toContainText("fixture-rule-2");
  await stop.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-rule-2",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationCancelReply(),
  );
  await expect(status).toContainText("Waiting for Host to stop");
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(status).toContainText("Host confirmed that the task stopped.");
  expect(await invocations(page)).toHaveLength(2);
});

test("stopping while the rule permission check is held prevents dispatch", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready", delayRuleReply: "preflight" },
  });
  const dialog = await openRule(page);
  const arm = dialog.getByRole("button", { name: "Arm rule", exact: true });
  await arm.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationRuleReplyHeld),
    )
    .toBe("preflight");
  await dialog.getByRole("button", { name: "Stop rule", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rule preparation stopped before dispatch.",
  );
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationRuleReply(),
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationRuleReplyHeld),
    )
    .toBeNull();
  expect(await invocations(page)).toHaveLength(0);
  await arm.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rule matched and returned a notification.",
  );
  expect(await invocations(page)).toHaveLength(1);
});

test("a stop during admission waits for and cancels only the returned operation", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "held", delayRuleReply: "admission" },
  });
  const dialog = await openRule(page);
  const status = dialog.getByRole("status");
  await dialog.getByRole("button", { name: "Arm rule", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationRuleReplyHeld),
    )
    .toBe("admission");
  await dialog.getByRole("button", { name: "Stop rule", exact: true }).click();
  await expect(status).toContainText(
    "Stop requested. Waiting for the Host operation receipt",
  );
  const cancellationRequests = () =>
    page.evaluate(() =>
      window.workbenchFixture.invocations
        .filter((call) => call.actionId === "operation.cancel")
        .map((call) => call.target.id),
    );
  expect(await cancellationRequests()).toEqual([]);
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationRuleReply(),
  );
  await expect.poll(cancellationRequests).toEqual(["fixture-rule"]);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(status).toContainText("Host confirmed that the task stopped.");
});

test("an armed rule notifies after closing the panel and restores its verified result", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "held" } });
  const dialog = await openRule(page);
  await dialog.getByRole("button", { name: "Save JSON", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(1);
  await dialog.getByRole("button", { name: "Arm rule", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Rule armed and waiting for a match.",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() => {
    location.hash = "#/settings";
  });
  await expect(
    page.getByRole("button", { name: "Workspace menu", exact: true }),
  ).toBeHidden();
  await page.evaluate(() => window.workbenchFixture.finishRuleNotification());
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Bench alert received" }),
  ).toBeVisible();
  await page.evaluate(() => {
    location.hash = "#/";
  });
  const reopened = await openRuleMenu(page);
  await expect(reopened.getByRole("status")).toContainText(
    "Rule matched and returned a notification.",
  );
  await expect(reopened.getByRole("status")).toContainText("[2, 8)");
});

test("a late admission receipt preserves the verified result already seen in the operation stream", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    sendHistory: true,
    automation: { action, state: "held", delayRuleReply: "admission" },
  });
  const dialog = await openRule(page);
  const arm = dialog.getByRole("button", { name: "Arm rule", exact: true });
  const status = dialog.getByRole("status");
  await arm.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationRuleReplyHeld),
    )
    .toBe("admission");
  expect(
    await page.evaluate(() => window.workbenchFixture.emitRuleOperation()),
  ).toBe(1);
  await expect(status).toContainText("Task fixture-rule");
  await page.evaluate(() => window.workbenchFixture.finishRuleNotification());
  await expect(status).toContainText(
    "Rule matched and returned a notification.",
  );
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationRuleReply(),
  );
  await expect(arm).toBeEnabled();
  await expect(status).toContainText("[2, 8)");
});

test("closing the panel during cancellation authorization preserves the explicit stop", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "held", delayRuleReply: "cancelCheck" },
  });
  const dialog = await openRule(page);
  await dialog.getByRole("button", { name: "Save JSON", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(1);
  await dialog.getByRole("button", { name: "Arm rule", exact: true }).click();
  await dialog.getByRole("button", { name: "Stop rule", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.automationRuleReplyHeld),
    )
    .toBe("cancelCheck");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() =>
    window.workbenchFixture.releaseAutomationRuleReply(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations.some(
          (call) =>
            call.actionId === "operation.cancel" &&
            call.target.id === "fixture-rule",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  const reopened = await openRuleMenu(page);
  await expect(reopened.getByRole("status")).toContainText(
    "Host confirmed that the task stopped.",
  );
});
