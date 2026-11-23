import { expect, test } from "@playwright/test";
import { en } from "../../src/i18n/en";
import { session } from "../../src/features/workbench/test-fixtures";
import type { DeviceDescriptor } from "@serial-workbench/contracts";
import { seedWorkbenchFixture } from "./workbench.fixture";

const device = {
  deviceId: "device",
  hostId: "workbench-gui-host",
  systemName: "Reference TCP",
  fingerprint: { transport: "plugin", evidence: "unreliable" },
  capabilities: session().capabilities,
} satisfies DeviceDescriptor;

test("plugin connection sends only valid JSON objects and retains the draft on a Host error", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    device,
    connectFailure: {
      code: "DEVICE_BUSY",
      message: "Fixture device is busy",
      retryable: true,
    },
  });
  await page.goto("./#/");
  const open = page.getByRole("button", {
    name: `${en["workbench.open"]} ${device.systemName}`,
    exact: true,
  });
  await open.click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.pluginTransportParameters"],
  });
  const parameters = dialog.getByRole("textbox", { name: device.systemName });
  const connect = dialog.getByRole("button", { name: en["workbench.open"] });
  await expect(parameters).toBeFocused();
  await parameters.fill('{"port": 9007199254740992}');
  await connect.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["workbench.pluginTransportInvalid"],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([]);

  const draft = '{"port": 43210}';
  await parameters.fill(draft);
  await connect.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["nativeError.deviceBusy"],
  );
  await expect(parameters).toHaveValue(draft);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([
    {
      deviceId: "device",
      params: expect.objectContaining({ transportParams: { port: 43210 } }),
    },
  ]);

  await parameters.press("Escape");
  await page.getByRole("button", { name: en["lifecycle.discard"] }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test("successful plugin connection clears its parameter draft from window work", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { device });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: `${en["workbench.open"]} ${device.systemName}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.pluginTransportParameters"],
  });
  await dialog
    .getByRole("textbox", { name: device.systemName })
    .fill('{"port": 43210}');
  const workNames = () =>
    page.evaluate(() => window.workbenchFixture.windowWorkNames);
  await expect
    .poll(workNames)
    .toContain(en["workbench.pluginTransportParameters"]);
  await dialog.getByRole("button", { name: en["workbench.open"] }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(workNames)
    .not.toContain(en["workbench.pluginTransportParameters"]);
});
