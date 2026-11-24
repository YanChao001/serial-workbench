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

const builtinRfc2217 = {
  ...device,
  systemName: "swb.builtin.rfc2217.transport",
  driver: "swb.builtin.rfc2217",
} satisfies DeviceDescriptor;

test("the wide RFC 2217 form keeps the negotiated line settings in the session request", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, {
    device: builtinRfc2217,
    openedCapabilities: {
      semantics: "stream",
      configuration: false,
      dtr: true,
      rts: false,
      finiteBreak: false,
      queueStatus: false,
      drain: false,
      purgeRx: false,
      purgeTx: false,
    },
    openedConfiguration: {
      ...session().configuration,
      baudRate: "230400",
      dataBits: "5",
      stopBits: "onePointFive",
      flowControl: "rtsCts",
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: "Open RFC 2217 remote serial",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "RFC 2217 remote serial" });
  const address = dialog.getByRole("textbox", { name: "Remote address" });
  const port = dialog.getByRole("textbox", { name: "Port", exact: true });
  const baud = dialog.getByRole("textbox", { name: "Baud rate (bit/s)" });
  const connect = dialog.getByRole("button", { name: "Connect", exact: true });
  await expect(address).toBeFocused();
  await expect(baud).toHaveValue("115200");
  await address.fill("serial-gateway.local");
  await connect.click();
  await expect(port).toBeFocused();
  await port.fill("2217");
  await baud.fill("230400");
  const summary = dialog.locator("summary");
  await summary.focus();
  await summary.press("Enter");
  const data = dialog.getByRole("combobox", { name: "Data bits" });
  const stop = dialog.getByRole("combobox", { name: "Stop bits" });
  const flow = dialog.getByRole("combobox", { name: "Flow control" });
  const dtr = dialog.getByRole("combobox", { name: "DTR" });
  const rts = dialog.getByRole("combobox", { name: "RTS" });
  await expect(data).toBeVisible();
  await stop.click();
  await page.getByRole("option", { name: "1.5", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Choose 5 data bits to use 1.5 stop bits.",
  );
  await summary.press("Enter");
  await connect.click();
  await expect(stop).toBeFocused();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([]);
  await data.click();
  await page.getByRole("option", { name: "5", exact: true }).click();
  await dtr.click();
  await page.getByRole("option", { name: "Set", exact: true }).click();
  await rts.click();
  await page.getByRole("option", { name: "Clear", exact: true }).click();
  await flow.click();
  await page.getByRole("option", { name: "RTS/CTS", exact: true }).click();
  await expect(rts).toBeDisabled();
  await expect(rts).toHaveAccessibleDescription(
    "RTS is managed by hardware flow control.",
  );
  const [addressBox, portBox, dataBox, stopBox, connectBox] = await Promise.all(
    [address, port, data, stop, connect].map((control) =>
      control.boundingBox(),
    ),
  );
  expect(addressBox!.y).toBe(portBox!.y);
  expect(dataBox!.y).toBe(stopBox!.y);
  expect(dataBox!.x).toBe(addressBox!.x);
  expect(
    new Set([
      addressBox!.height,
      portBox!.height,
      dataBox!.height,
      stopBox!.height,
      connectBox!.height,
    ]).size,
  ).toBe(1);
  await dialog.screenshot({ path: info.outputPath("rfc2217-wide.png") });
  await connect.click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([
    {
      deviceId: builtinRfc2217.deviceId,
      params: expect.objectContaining({
        configuration: expect.objectContaining({
          baudRate: "230400",
          dataBits: "5",
          parity: "none",
          stopBits: "onePointFive",
          flowControl: "rtsCts",
        }),
        transportParams: {
          host: "serial-gateway.local",
          port: 2217,
          baudRate: 230400,
          dataBits: 5,
          parity: "none",
          stopBits: "1.5",
          flowControl: "hardware",
          dtr: true,
        },
      }),
    },
  ]);
  const controls = page.getByRole("button", {
    name: "Control lines and receipts",
    exact: true,
  });
  await controls.click();
  await page.mouse.move(0, 0);
  const controlDialog = page.getByRole("dialog", {
    name: "Control lines and receipts",
  });
  const dtrOn = controlDialog.getByRole("button", {
    name: "DTR on",
    exact: true,
  });
  const dtrOff = controlDialog.getByRole("button", {
    name: "DTR off",
    exact: true,
  });
  const rtsOn = controlDialog.getByRole("button", {
    name: "RTS on",
    exact: true,
  });
  const rtsOff = controlDialog.getByRole("button", {
    name: "RTS off",
    exact: true,
  });
  const layout = async () => {
    const [dtr, dtrReset, rts, rtsReset] = await Promise.all(
      [dtrOn, dtrOff, rtsOn, rtsOff].map((button) => button.boundingBox()),
    );
    return {
      sameRow: dtr!.y === rts!.y,
      dtrTogether: dtr!.y === dtrReset!.y,
      rtsTogether: rts!.y === rtsReset!.y,
      sameSize:
        new Set([dtr!.height, dtrReset!.height, rts!.height, rtsReset!.height])
          .size === 1,
    };
  };
  await expect(dtrOn).toBeEnabled();
  await expect(rtsOn).toBeDisabled();
  await expect(
    controlDialog.getByText("Flow control owns this line", { exact: true }),
  ).toBeVisible();
  await expect.poll(layout).toEqual({
    sameRow: true,
    dtrTogether: true,
    rtsTogether: true,
    sameSize: true,
  });
  await controlDialog.screenshot({
    path: info.outputPath("rfc2217-live-wide.png"),
  });
  await page.setViewportSize({ width: 420, height: 460 });
  await expect.poll(layout).toEqual({
    sameRow: false,
    dtrTogether: true,
    rtsTogether: true,
    sameSize: true,
  });
  await controlDialog.screenshot({
    path: info.outputPath("rfc2217-live-narrow.png"),
  });
});

test("the short Chinese RFC 2217 form keeps one retry message and the connection draft", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 460 });
  await seedWorkbenchFixture(page, {
    device: builtinRfc2217,
    language: "zh",
    theme: "dark",
    sharedSettings: { fontSize: "lg" },
    connectFailure: {
      code: "PLUGIN_TRANSPORT_OPEN_FAILED",
      message: "Fixture serial gateway did not confirm a parameter",
      retryable: false,
      details: {
        protocol: "rfc2217",
        reason: "different_value",
        field: "baudRate",
        requestedValue: 57600,
        reportedValue: 9600,
      },
    },
  });
  await page.goto("./#/");
  const open = page.getByRole("button", {
    name: "打开 RFC 2217 远程串口",
    exact: true,
  });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "RFC 2217 远程串口" });
  const address = dialog.getByRole("textbox", {
    name: "远端地址",
    exact: true,
  });
  const port = dialog.getByRole("textbox", { name: "端口", exact: true });
  const baud = dialog.getByRole("textbox", {
    name: "波特率（bit/s）",
    exact: true,
  });
  const connect = dialog.getByRole("button", { name: "连接", exact: true });
  const host = "serial-gateway-line-b-controller-access.example";
  await address.fill(host);
  await port.fill("2217");
  await baud.fill("57600");
  const [addressBox, portBox, baudBox] = await Promise.all(
    [address, port, baud].map((control) => control.boundingBox()),
  );
  expect(portBox!.x).toBe(addressBox!.x);
  expect(baudBox!.x).toBe(addressBox!.x);
  expect(portBox!.y).toBeGreaterThanOrEqual(addressBox!.y + addressBox!.height);
  expect(baudBox!.y).toBeGreaterThanOrEqual(portBox!.y + portBox!.height);
  await baud.press("Enter");
  const message = "波特率不一致。请求 57600 bit/s，对端回报 9600 bit/s。";
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(message);
  await expect(page.getByText(message, { exact: true })).toHaveCount(1);
  const [errorBounds, buttonBounds] = await Promise.all([
    alert.boundingBox(),
    connect.boundingBox(),
  ]);
  expect(errorBounds!.y + errorBounds!.height).toBeLessThan(buttonBounds!.y);
  await expect(address).toHaveValue(host);
  await expect(port).toHaveValue("2217");
  await expect(baud).toHaveValue("57600");
  await expect(connect).toBeEnabled();
  await dialog.screenshot({ path: info.outputPath("rfc2217-narrow.png") });
  await connect.click();
  await expect(dialog.getByRole("alert")).toHaveText(message);
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.connectRequests.length),
    )
    .toBe(2);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃并继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});
