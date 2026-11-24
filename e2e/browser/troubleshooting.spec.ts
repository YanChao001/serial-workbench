import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/i18n/en";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

async function openGuide(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Troubleshooting", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Troubleshooting", exact: true });
}

async function inspect(page: Page, problem: string) {
  await page.getByRole("combobox", { name: "Problem to check" }).click();
  await page.getByRole("option", { name: problem, exact: true }).click();
}

test("a failed open keeps its port and retries only after the operator asks", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    connectFailure: {
      code: "ACCESS_DENIED",
      message: "private fixture detail",
      retryable: false,
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.connectCalls))
    .toEqual(["device"]);

  const dialog = await openGuide(page);
  await inspect(page, "Cannot open port");
  await expect(
    dialog.getByText("ACCESS_DENIED", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Cannot connect · Virtual serial" }),
  ).toBeVisible();
  await expect(dialog.getByText("private fixture detail")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.connectCalls))
    .toEqual(["device", "device"]);
});

test("encoding diagnosis uses live RX and returns to the same view without resending", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const current = page.getByRole("tab", {
    name: "Virtual serial",
    exact: true,
  });
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const subscription = await page.evaluate(() =>
    window.workbenchFixture.rawSubscriptions.slice(),
  );

  const items = workbenchStreamItems();
  const rx = items.find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (rx?.kind !== "source" || rx.event.kind !== "rx")
    throw new Error("Missing RX sample");
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("RX VERIFIED", "utf16le"),
  ]);
  rx.event.payload.bytesBase64 = bytes.toString("base64");
  rx.event.payload.byteEnd = String(bytes.length);
  await page.evaluate(
    (value: unknown[]) => window.workbenchFixture.emitRaw(value),
    items as unknown[],
  );

  const dialog = await openGuide(page);
  await inspect(page, "Garbled text");
  await expect(dialog.getByText("UTF-16 LE", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Byte-order mark", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Use encoding and view text" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("RX VERIFIED", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.rawSubscriptions),
  ).toEqual(subscription);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await expect(
    page.getByRole("button", { name: en["workbench.tools.more"], exact: true }),
  ).toBeFocused();
});
