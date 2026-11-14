/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { zhCN } from "../../src/i18n/zh-CN";
import { en } from "../../src/i18n/en";

test("slow configuration observations keep the click usable and recheck its exact input", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "zh", theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: `${zhCN["workbench.open"]} Virtual serial`,
      exact: true,
    })
    .click();
  await page.evaluate(() => {
    window.workbenchFixture.configureCheckDelayMs = 1200;
  });
  await page
    .getByRole("button", {
      name: zhCN["workbench.tools.parameters"],
      exact: true,
    })
    .click();
  await page
    .getByRole("combobox", { name: zhCN["workbench.tools.baudRate"] })
    .fill("57600");
  const apply = page.getByRole("button", {
    name: zhCN["workbench.tools.applyConfiguration"],
    exact: true,
  });
  await expect(apply).toBeEnabled();
  await page.evaluate(() => {
    window.workbenchFixture.configureAllowed = false;
  });
  const count = await page.evaluate(
    () => window.workbenchFixture.queryInputs.length,
  );
  await apply.click();
  await expect(apply).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    zhCN["nativeError.permissionDenied"],
  );
  expect(
    await page.evaluate((start) => {
      const fixture = window.workbenchFixture;
      return {
        checked: fixture.queryInputs
          .slice(start)
          .some(
            (query) =>
              query.actionId === "action.check" &&
              query.params.actionId === "session.configure" &&
              typeof query.params.params === "object" &&
              query.params.params !== null &&
              "requested" in query.params.params &&
              typeof query.params.params.requested === "object" &&
              query.params.params.requested !== null &&
              "baudRate" in query.params.params.requested &&
              query.params.params.requested.baudRate === "57600",
          ),
        invoked: fixture.invocations.some(
          (call) => call.actionId === "session.configure",
        ),
      };
    }, count),
  ).toEqual({ checked: true, invoked: false });
});

for (const sample of [
  { language: "zh", theme: "dark", width: 1400 },
  { language: "en", theme: "light", width: 880 },
] as const) {
  test(`configuration changes use notifications and leave received data clear (${sample.language})`, async ({
    page,
  }, info) => {
    const messages = sample.language === "zh" ? zhCN : en;
    await page.setViewportSize({ width: sample.width, height: 925 });
    await seedWorkbenchFixture(page, sample);
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${messages["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBeGreaterThan(0);
    const item = workbenchStreamItems().find(
      (value) => value.kind === "source",
    );
    if (!item || item.kind !== "source")
      throw new Error("Missing source fixture");
    const events = [
      {
        kind: "source",
        event: {
          ...item.event,
          eventSeq: "6387",
          kind: "configuration_boundary",
          payload: {
            revision: "2",
            certainty: "confirmed",
            receiptRef: {
              hostId: item.event.hostId,
              kind: "operation",
              id: "configuration",
            },
          },
        },
      },
      {
        kind: "source",
        event: {
          ...item.event,
          eventSeq: "6388",
          kind: "configuration_boundary",
          payload: {
            revision: "3",
            certainty: "uncertain",
            receiptRef: {
              hostId: item.event.hostId,
              kind: "operation",
              id: "configuration-uncertain",
            },
          },
        },
      },
      {
        kind: "source",
        event: {
          ...item.event,
          eventSeq: "6389",
          kind: "control",
          payload: {},
        },
      },
    ];
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      events.slice(0, 1),
    );
    const log = page.getByRole("log", {
      name: messages["workbench.terminal"],
      exact: true,
    });
    await expect(
      page.getByText(messages["workbench.configurationApplied"], {
        exact: true,
      }),
    ).toBeVisible();
    await expect(log).not.toContainText(
      messages["workbench.configurationApplied"],
    );
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      events.slice(1),
    );
    await expect(
      page.getByText(messages["workbench.configurationUncertain"], {
        exact: true,
      }),
    ).toBeVisible();
    await expect(log).not.toContainText(
      messages["workbench.configurationUncertain"],
    );
    await expect(
      log.getByText(messages["workbench.controlEvent"], { exact: true }),
    ).toBeVisible();
    await expect(log).not.toContainText("CONFIGURATION_BOUNDARY");
    await expect(log).not.toContainText("6387");
    for (const row of await log.locator(".workbench-stream-row").all()) {
      const icon = await row.locator(".workbench-direction").boundingBox();
      const content = await row
        .locator(".workbench-stream-content")
        .boundingBox();
      expect(icon!.x + icon!.width).toBeLessThanOrEqual(content!.x);
    }
    await page.screenshot({
      path: info.outputPath("configuration-events.png"),
    });
  });
}
