import { expect, test } from "@playwright/test";
import { en } from "../../src/i18n/en";
import { session } from "../../src/features/workbench/test-fixtures";
import type { DeviceDescriptor } from "@serial-workbench/contracts";
import { seedWorkbenchFixture } from "./workbench.fixture";

const device = {
  deviceId: "device",
  hostId: "workbench-gui-host",
  systemName: "reference.transport.tcp",
  driver: "reference.transport",
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

const builtinTcp = {
  ...device,
  systemName: "swb.builtin.tcp.transport",
  driver: "swb.builtin.tcp",
} satisfies DeviceDescriptor;

test("the bundled TCP server validates fields and opens through the normal device action", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 780 });
  await seedWorkbenchFixture(page, { device: builtinTcp });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: "Open " + builtinTcp.systemName,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: en["tcpConnection.title"] });
  const role = dialog.getByRole("combobox", { name: en["tcpConnection.role"] });
  const port = dialog.getByRole("textbox", { name: en["tcpConnection.port"] });
  const remote = dialog.getByRole("textbox", {
    name: en["tcpConnection.remoteAddress"],
  });
  await expect(role).toBeFocused();
  await expect(remote).toHaveValue("127.0.0.1");
  await dialog
    .getByRole("button", { name: en["tcpConnection.connect"], exact: true })
    .click();
  await expect(port).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["tcpConnection.invalidPort"],
  );

  await remote.fill("localhost");
  await port.fill("43210");
  await role.press("Enter");
  await page
    .getByRole("option", { name: en["tcpConnection.server"], exact: true })
    .click();
  await expect(role).toHaveText(en["tcpConnection.server"]);
  await expect(role).toBeFocused();
  const local = dialog.getByRole("textbox", {
    name: en["tcpConnection.bindAddress"],
  });
  const listen = dialog.getByRole("button", {
    name: en["tcpConnection.listen"],
    exact: true,
  });
  await expect(local).toHaveValue("localhost");
  await expect(port).toHaveValue("43210");
  await listen.click();
  await expect(local).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["tcpConnection.invalidBindAddress"],
  );
  const requests = () =>
    page.evaluate(() => window.workbenchFixture.connectRequests);
  expect(await requests()).toEqual([]);

  await local.fill("::1");
  const [roleBox, addressBox, portBox, buttonBox] = await Promise.all(
    [role, local, port, listen].map((control) => control.boundingBox()),
  );
  expect(addressBox!.y).toBe(portBox!.y);
  expect(addressBox!.x).toBe(roleBox!.x);
  expect(
    new Set([
      roleBox!.height,
      addressBox!.height,
      portBox!.height,
      buttonBox!.height,
    ]).size,
  ).toBe(1);
  await dialog.screenshot({ path: info.outputPath("tcp-server-wide.png") });
  await listen.click();
  await expect(dialog).toBeHidden();
  expect(await requests()).toEqual([
    {
      deviceId: builtinTcp.deviceId,
      params: expect.objectContaining({
        transportParams: { role: "server", host: "::1", port: 43210 },
      }),
    },
  ]);
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.windowWorkNames))
    .not.toContain(en["tcpConnection.title"]);
});

test("the narrow Chinese TCP client keeps an editable draft after a Host failure", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 560 });
  await seedWorkbenchFixture(page, {
    device: builtinTcp,
    language: "zh",
    theme: "dark",
    connectFailure: {
      code: "DEVICE_BUSY",
      message: "Fixture device is busy",
      retryable: true,
    },
  });
  await page.goto("./#/");
  const open = page.getByRole("button", {
    name: "打开 " + builtinTcp.systemName,
    exact: true,
  });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "TCP 连接", exact: true });
  const remote = dialog.getByRole("textbox", { name: "远端地址", exact: true });
  const port = dialog.getByRole("textbox", { name: "端口", exact: true });
  await remote.fill("debug.example");
  await port.fill("65535");
  const [addressBox, portBox] = await Promise.all([
    remote.boundingBox(),
    port.boundingBox(),
  ]);
  expect(portBox!.x).toBe(addressBox!.x);
  expect(portBox!.y).toBeGreaterThanOrEqual(addressBox!.y + addressBox!.height);
  await port.press("Enter");
  const inlineError = dialog.getByRole("alert");
  await expect(inlineError).toBeVisible();
  const message = await inlineError.innerText();
  await expect(page.getByText(message, { exact: true })).toHaveCount(1);
  const connect = dialog.getByRole("button", { name: "连接", exact: true });
  await expect(connect).toBeEnabled();
  await expect
    .poll(() =>
      connect.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return hit !== null && button.contains(hit);
      }),
    )
    .toBe(true);
  await expect(remote).toHaveValue("debug.example");
  await expect(port).toHaveValue("65535");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([
    {
      deviceId: builtinTcp.deviceId,
      params: expect.objectContaining({
        transportParams: { role: "client", host: "debug.example", port: 65535 },
      }),
    },
  ]);
  await dialog.screenshot({ path: info.outputPath("tcp-client-narrow.png") });
  await port.press("Escape");
  await page.getByRole("button", { name: "放弃并继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});
