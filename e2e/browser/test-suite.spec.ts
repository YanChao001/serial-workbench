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

async function openSuite(page: Page) {
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Test suites", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Test suites", exact: true });
}

async function suiteCalls(page: Page) {
  return page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter(
        (call) => call.actionId === id,
      ),
    builtinCommandSequenceAction,
  );
}

test("the workbench runs ordered cases and exports reports and trends from two actual runs", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: {
      action,
      state: "ready",
      sequenceSuiteOutcomes: ["passed", "passed", "passed", "failed"],
    },
  });
  const dialog = await openSuite(page);
  const input = dialog.getByRole("textbox", {
    name: "Test suite definition (JSON)",
  });
  const cases = ["Read <one>", "Read two", "Disabled"].map((name, index) => ({
    name,
    skip: index === 2,
    sequence: {
      version: 1,
      steps: [
        {
          kind: "send",
          hex: String(53 + index),
          expect: { hex: String(53 + index) },
        },
      ],
    },
  }));
  await input.fill(
    JSON.stringify({ version: 1, name: "Bench <suite>", cases }),
  );
  const run = dialog.getByRole("button", { name: "Run suite" });
  expect(await suiteCalls(page)).toHaveLength(0);

  await run.click();
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /Read two Passed suite-case-2/ }),
  ).toBeVisible();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(
    results.getByRole("row", {
      name: /Read two Failed response_timeout suite-case-4/,
    }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", { name: /Disabled Skipped configured_skip/ }),
  ).toBeVisible();

  const history = dialog.getByRole("list", { name: "Run history" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history).toContainText("2 of 3 cases passed");
  await expect(history).toContainText("1 of 3 cases passed");
  const calls = await suiteCalls(page);
  expect(calls).toHaveLength(4);
  expect(calls.map(({ params }) => params.startEventSeq)).toEqual([
    "1",
    "5",
    "9",
    "13",
  ]);
  expect(
    calls.map(
      ({ params }) => JSON.parse(String(params.definition)).steps[0].hex,
    ),
  ).toEqual(["53", "54", "53", "54"]);

  await dialog.getByRole("button", { name: "Export JUnit XML" }).click();
  await dialog.getByRole("button", { name: "Export HTML" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(2);
  const files = await page.evaluate(
    () => window.workbenchFixture.savedTextExports,
  );
  expect(files.map(({ name }) => name)).toEqual([
    "test-suite-report.xml",
    "test-suite-report.html",
  ]);
  expect(files[0]?.content).toContain('failures="1"');
  expect(files[0]?.content).toContain("<system-out>suite-case-4</system-out>");
  expect(files[1]?.content).toContain("Bench &lt;suite&gt;");
  expect(files[1]?.content).toContain('table id="history"');
  await dialog.getByRole("button", { name: "Save JSON" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(3);
  await expect(dialog.getByRole("button", { name: "Save JSON" })).toBeEnabled();
  await expect(run).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Test suites", exact: true })
    .click();
  await expect(history.getByRole("listitem")).toHaveCount(2);
});

test("CSV rounds preserve physical lines, typed inputs and results after a failure", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: {
      action,
      state: "ready",
      sequenceSuiteOutcomes: ["passed", "failed"],
    },
  });
  const dialog = await openSuite(page);
  await dialog
    .getByRole("button", { name: "Load data-driven example" })
    .click();
  await expect(dialog.getByText("2 test rounds ready")).toBeVisible();
  const input = dialog.getByRole("textbox", {
    name: "Test suite definition (JSON)",
  });
  const example = await input.inputValue();
  await dialog.getByText("CSV inputs", { exact: true }).click();

  async function pickCsv(csv: string) {
    const file = page.waitForEvent("filechooser");
    await dialog
      .getByRole("button", { name: "Replace CSV for Echo payload" })
      .click();
    await (
      await file
    ).setFiles({
      name: "rounds.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  }

  await pickCsv("Byte\r\n65\r\n999\r\n");
  await expect(dialog.getByRole("alert")).toContainText(
    "$.cases[0].data.csv[3].payload",
  );
  await expect(input).toHaveValue(example);
  await pickCsv('Byte,Note\r\n65,"row\r\none"\r\n66,two\r\n67,three\r\n');
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText("3 test rounds ready")).toBeVisible();
  expect(await suiteCalls(page)).toHaveLength(0);

  await dialog.getByRole("button", { name: "Run suite" }).click();
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /CSV line 2 Passed suite-case-1/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", {
      name: /CSV line 4 Failed response_timeout suite-case-2/,
    }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", { name: /CSV line 5 Skipped/ }),
  ).toBeVisible();
  expect(
    (await suiteCalls(page)).map(
      ({ params }) => JSON.parse(String(params.definition)).variables.payload,
    ),
  ).toEqual(["41", "42"]);

  await dialog.getByRole("button", { name: "Export JUnit XML" }).click();
  await dialog.getByRole("button", { name: "Export HTML" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(2);
  const files = await page.evaluate(
    () => window.workbenchFixture.savedTextExports,
  );
  expect(files[0]?.content).toContain('name="Echo payload [CSV line 4]"');
  expect(files[1]?.content).toContain("<td>CSV line 5</td>");
  expect(files.map(({ content }) => content).join("\n")).not.toContain(
    "Byte,Note",
  );

  await pickCsv(
    'Byte,Note\r\n65,"different note\r\none"\r\n66,two\r\n67,three\r\n',
  );
  await expect(input).toHaveValue(/different note/);
  await expect(results).toHaveCount(0);
  expect(await suiteCalls(page)).toHaveLength(2);
});

test("stopping awaits the active Host operation before classifying cancellation and skip", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "held" } });
  const dialog = await openSuite(page);
  await dialog.getByRole("button", { name: "Load example" }).click();
  await dialog.getByRole("button", { name: "Run suite" }).click();
  await expect.poll(async () => (await suiteCalls(page)).length).toBe(1);
  await dialog.getByRole("button", { name: "Stop suite" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Waiting for the active case",
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
  await expect(
    dialog.getByRole("cell", { name: "Cancelled", exact: false }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /Echo 53 Cancelled fixture-sequence/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", { name: /Echo 54 Skipped/ }),
  ).toBeVisible();
  expect(await suiteCalls(page)).toHaveLength(1);
});

test("an authoritative configuration revision change prevents any suite admission", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "ready" } });
  const dialog = await openSuite(page);
  await dialog.getByRole("button", { name: "Load example" }).click();
  await page.evaluate(() => {
    window.workbenchFixture.suiteConfigurationRevision = "92";
  });
  await dialog.getByRole("button", { name: "Run suite" }).click();
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /Echo 53 Unverified scope_unverified/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", { name: /Echo 54 Skipped/ }),
  ).toBeVisible();
  expect(await suiteCalls(page)).toHaveLength(0);
});

test("a confirmed write without an assertion cannot supply a later case's reply", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    automation: { action, state: "ready", sequenceSuiteOutcomes: ["written"] },
  });
  const dialog = await openSuite(page);
  const input = dialog.getByRole("textbox", {
    name: "Test suite definition (JSON)",
  });
  await input.fill(
    JSON.stringify({
      version: 1,
      name: "Unresolved peer",
      cases: [
        {
          name: "Write only",
          sequence: { version: 1, steps: [{ kind: "send", hex: "51" }] },
        },
        {
          name: "Read next",
          sequence: {
            version: 1,
            steps: [{ kind: "send", hex: "52", expect: { hex: "51" } }],
          },
        },
      ],
    }),
  );
  const run = dialog.getByRole("button", { name: "Run suite" });
  await run.click();
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /Write only Passed suite-case-1/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("row", {
      name: /Read next Skipped previous_case_unresolved_replies/,
    }),
  ).toBeVisible();
  await expect(run).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "Verify the peer has stopped",
  );
  expect(await suiteCalls(page)).toHaveLength(1);

  const definition = await input.inputValue();
  await dialog.getByRole("button", { name: "Save JSON" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.savedTextExports.length),
    )
    .toBe(1);
  await expect(dialog.getByRole("button", { name: "Save JSON" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() => {
    location.hash = "#/settings";
  });
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await expect(menu).toBeHidden();
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await expect(menu).toBeVisible();
  await menu.press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Test suites", exact: true })
    .click();
  await input.fill(definition);
  await expect(run).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText(
    "Verify the peer has stopped",
  );
  expect(await suiteCalls(page)).toHaveLength(1);
});

test("permission preflight denial does not poison the session's next suite run", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { automation: { action, state: "denied" } });
  const dialog = await openSuite(page);
  await dialog.getByRole("button", { name: "Load example" }).click();
  const run = dialog.getByRole("button", { name: "Run suite" });
  await run.click();
  const results = dialog.getByRole("table", { name: "Case results" });
  await expect(
    results.getByRole("row", { name: /Echo 53 Unverified scope_unverified/ }),
  ).toBeVisible();
  await expect(run).toBeEnabled();
  expect(await suiteCalls(page)).toHaveLength(0);
});
