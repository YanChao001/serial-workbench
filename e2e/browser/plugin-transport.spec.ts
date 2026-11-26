import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { TransportOpenHandler } from "../../packages/plugin-sdk/src/node";
import { en } from "../../src/i18n/en";
import { session } from "../../src/features/workbench/test-fixtures";
import type { DeviceDescriptor } from "@serial-workbench/contracts";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { register as registerDeviceWebsocket } from "../../packages/plugin-sdk/examples/reference-websocket/builtin";

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

const builtinUdp = {
  ...device,
  systemName: "swb.builtin.udp.transport",
  driver: "swb.builtin.udp",
} satisfies DeviceDescriptor;

test("the wide UDP form submits the IPv6 multicast interface and preserves mode drafts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, { device: builtinUdp });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open UDP datagrams", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "UDP datagrams",
    exact: true,
  });
  const family = dialog.getByRole("combobox", { name: "Address family" });
  const mode = dialog.getByRole("combobox", { name: "Mode", exact: true });
  const open = dialog.getByRole("button", {
    name: "Open session",
    exact: true,
  });
  await expect(family).toBeFocused();
  await mode.click();
  await expect(
    page.getByRole("option", { name: "Broadcast", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Multicast", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Multicast group address" })
    .fill("239.255.15.42");
  await family.click();
  await page.getByRole("option", { name: "IPv6", exact: true }).click();
  await mode.click();
  await expect(
    page.getByRole("option", { name: "Broadcast", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "Unicast", exact: true }).click();
  await mode.click();
  await page.getByRole("option", { name: "Multicast", exact: true }).click();
  const group = dialog.getByRole("textbox", {
    name: "Multicast group address",
  });
  const port = dialog.getByRole("textbox", { name: "Destination port" });
  const iface = dialog.getByRole("textbox", { name: "Multicast interface" });
  await expect(
    dialog.getByRole("textbox", { name: "Local address", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("textbox", { name: "Local port", exact: true }),
  ).toHaveAccessibleDescription("Defaults to the destination port.");
  await expect(group).toHaveValue("");
  await group.fill("ff02::114");
  await port.fill("42000");
  await open.click();
  await expect(iface).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["udpConnection.interfaceIndex"],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([]);
  await iface.fill("1");
  await family.click();
  await page.getByRole("option", { name: "IPv4", exact: true }).click();
  await expect(group).toHaveValue("239.255.15.42");
  await family.click();
  await page.getByRole("option", { name: "IPv6", exact: true }).click();
  await expect(group).toHaveValue("ff02::114");
  await expect(port).toHaveValue("42000");
  await expect(iface).toHaveValue("1");
  const [familyBox, groupBox, portBox, openBox] = await Promise.all(
    [family, group, port, open].map((control) => control.boundingBox()),
  );
  expect(groupBox!.y).toBe(portBox!.y);
  expect(groupBox!.x).toBe(familyBox!.x);
  expect(
    new Set([
      familyBox!.height,
      groupBox!.height,
      portBox!.height,
      openBox!.height,
    ]).size,
  ).toBe(1);
  await dialog.screenshot({ path: info.outputPath("udp-multicast-wide.png") });
  await open.click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([
    {
      deviceId: builtinUdp.deviceId,
      params: expect.objectContaining({
        transportParams: {
          family: "ipv6",
          mode: "multicast",
          host: "ff02::114",
          port: 42000,
          multicastInterface: "1",
        },
      }),
    },
  ]);
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.windowWorkNames))
    .not.toContain(en["udpConnection.title"]);
});

test("the narrow Chinese UDP form retains a failed broadcast draft and returns focus", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 540 });
  await seedWorkbenchFixture(page, {
    device: builtinUdp,
    language: "zh",
    theme: "dark",
    connectFailure: {
      code: "DEVICE_BUSY",
      message: "Fixture device is busy",
      retryable: true,
    },
  });
  await page.goto("./#/");
  const connection = page.getByRole("button", {
    name: "打开 UDP 数据报",
    exact: true,
  });
  await connection.click();
  const dialog = page.getByRole("dialog", { name: "UDP 数据报", exact: true });
  await dialog.getByRole("combobox", { name: "模式", exact: true }).click();
  await page.getByRole("option", { name: "广播", exact: true }).click();
  const host = dialog.getByRole("textbox", { name: "广播地址", exact: true });
  const port = dialog.getByRole("textbox", { name: "目标端口", exact: true });
  await host.fill("255.255.255.255");
  await port.fill("42000");
  const [hostBox, portBox] = await Promise.all([
    host.boundingBox(),
    port.boundingBox(),
  ]);
  expect(portBox!.x).toBe(hostBox!.x);
  expect(portBox!.y).toBeGreaterThanOrEqual(hostBox!.y + hostBox!.height);
  await dialog.getByRole("button", { name: "打开会话", exact: true }).click();
  const feedback = dialog.getByRole("alert");
  await expect(feedback).toBeVisible();
  await expect(
    page.getByText(await feedback.innerText(), { exact: true }),
  ).toHaveCount(1);
  await expect(host).toHaveValue("255.255.255.255");
  await expect(port).toHaveValue("42000");
  await dialog.screenshot({
    path: info.outputPath("udp-broadcast-narrow.png"),
  });
  await port.fill("42001");
  await expect(feedback).toHaveCount(0);
  await port.press("Escape");
  await page.getByRole("button", { name: "放弃并继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(connection).toBeFocused();
});

const builtinWebsocket = {
  ...device,
  systemName: "swb.builtin.websocket.transport",
  driver: "swb.builtin.websocket",
} satisfies DeviceDescriptor;

test("Chromium exchanges messages over the independent device WebSocket listener", async ({
  page,
}) => {
  const reserved = createServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const address = reserved.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback address");
  await new Promise<void>((resolve) => reserved.close(() => resolve()));

  const registered: { open?: TransportOpenHandler } = {};
  const dispose = await registerDeviceWebsocket({
    transports: {
      register(_id: string, handler: TransportOpenHandler) {
        registered.open = handler;
      },
    },
  } as Parameters<typeof registerDeviceWebsocket>[0]);
  const peerPage = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Device WebSocket peer</title>");
  });
  try {
    // Chromium needs the real loopback response address for its network checks.
    peerPage.listen(0, "127.0.0.1");
    await once(peerPage, "listening");
    const peerAddress = peerPage.address();
    if (!peerAddress || typeof peerAddress === "string")
      throw new Error("No browser peer address");
    await page.goto("http://127.0.0.1:" + peerAddress.port + "/");
    const signal = AbortSignal.timeout(5_000);
    if (!registered.open)
      throw new Error("Device WebSocket was not registered");
    const connection = await registered.open({
      params: {
        role: "server",
        path: "/device",
        port: address.port,
        browserOrigin: new URL(page.url()).origin,
      },
      signal,
    });
    if (!("readMessage" in connection))
      throw new Error("Expected a message connection");
    const browser = page
      .evaluate(
        (url) =>
          new Promise<number[]>((resolve, reject) => {
            const socket = new WebSocket(url);
            socket.binaryType = "arraybuffer";
            socket.onopen = () => socket.send("Chromium");
            socket.onerror = () => reject(new Error("Device handshake failed"));
            socket.onclose = () =>
              reject(new Error("Device closed before sending a message"));
            socket.onmessage = (event: MessageEvent<unknown>) => {
              if (!(event.data instanceof ArrayBuffer)) {
                reject(new Error("Expected binary frame"));
                return;
              }
              resolve(Array.from(new Uint8Array(event.data)));
              socket.close(1000);
            };
          }),
        "ws://127.0.0.1:" + address.port + "/device",
      )
      .then(
        (data) => ({ data }),
        (error: unknown) => ({ error }),
      );
    const options = { maxBytes: 128 * 1024, waitMs: 4_000, signal };
    expect(await connection.readMessage(options)).toEqual({
      bytes: Buffer.from("Chromium"),
      messageType: "text",
    });
    expect(
      await connection.write({
        bytes: Uint8Array.of(0, 255, 13),
        waitMs: 2_000,
        signal,
      }),
    ).toBe(3);
    expect(await browser).toEqual({ data: [0, 255, 13] });
    expect(await connection.readMessage(options)).toBeNull();
  } finally {
    try {
      await dispose();
    } finally {
      await new Promise<void>((resolve) => peerPage.close(() => resolve()));
    }
  }
});

test("the wide WebSocket listener sends only its validated role parameters", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, { device: builtinWebsocket });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open WebSocket device", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "WebSocket device",
    exact: true,
  });
  const role = dialog.getByRole("combobox", { name: "Role", exact: true });
  const type = dialog.getByRole("combobox", { name: "Send type" });
  const url = dialog.getByRole("textbox", { name: "Endpoint URL" });
  await expect(role).toBeFocused();
  await url.fill("https://device.example/");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(url).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["websocketConnection.invalidUrl"],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([]);

  await url.fill("wss://device.example/data");
  await role.click();
  await page.getByRole("option", { name: "Listen for a peer" }).click();
  const port = dialog.getByRole("textbox", { name: "Port", exact: true });
  const local = dialog.getByRole("textbox", {
    name: "Local address",
    exact: true,
  });
  const origin = dialog.getByRole("textbox", { name: "Browser origin" });
  const listen = dialog.getByRole("button", {
    name: "Start listening",
    exact: true,
  });
  await expect(local).toHaveValue("127.0.0.1");
  await port.fill("43100");
  await origin.fill("http://localhost:5173/page");
  await listen.click();
  await expect(origin).toBeFocused();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["websocketConnection.invalidOrigin"],
  );
  await origin.fill("http://localhost:5173/");
  await type.click();
  await page.getByRole("option", { name: "UTF-8 text" }).click();
  await role.click();
  await page.getByRole("option", { name: "Connect to device" }).click();
  await expect(url).toHaveValue("wss://device.example/data");
  await role.click();
  await page.getByRole("option", { name: "Listen for a peer" }).click();
  await expect(port).toHaveValue("43100");

  const [roleBox, localBox, portBox, buttonBox] = await Promise.all(
    [role, local, port, listen].map((control) => control.boundingBox()),
  );
  expect(localBox!.y).toBe(portBox!.y);
  expect(localBox!.x).toBe(roleBox!.x);
  expect(
    new Set([
      roleBox!.height,
      localBox!.height,
      portBox!.height,
      buttonBox!.height,
    ]).size,
  ).toBe(1);
  await dialog.screenshot({
    path: info.outputPath("websocket-listener-wide.png"),
  });
  await listen.click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([
    {
      deviceId: builtinWebsocket.deviceId,
      params: expect.objectContaining({
        transportParams: {
          role: "server",
          sendType: "text",
          bindAddress: "127.0.0.1",
          port: 43100,
          path: "/device",
          browserOrigin: "http://localhost:5173",
        },
      }),
    },
  ]);
});

test("the narrow Chinese WebSocket client retains its draft and returns focus", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 540 });
  await seedWorkbenchFixture(page, {
    device: builtinWebsocket,
    language: "zh",
    theme: "dark",
    connectFailure: {
      code: "DEVICE_BUSY",
      message: "Fixture device is busy",
      retryable: true,
    },
  });
  await page.goto("./#/");
  const connection = page.getByRole("button", {
    name: "打开 WebSocket 设备",
    exact: true,
  });
  await connection.click();
  const dialog = page.getByRole("dialog", {
    name: "WebSocket 设备",
    exact: true,
  });
  const role = dialog.getByRole("combobox", { name: "角色", exact: true });
  const type = dialog.getByRole("combobox", { name: "发送类型", exact: true });
  const url = dialog.getByRole("textbox", { name: "端点 URL", exact: true });
  await url.fill("ws://[::1]:43100/device");
  const [roleBox, typeBox] = await Promise.all([
    role.boundingBox(),
    type.boundingBox(),
  ]);
  expect(roleBox!.x).toBe(typeBox!.x);
  expect(typeBox!.y).toBeGreaterThanOrEqual(roleBox!.y + roleBox!.height);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  const feedback = dialog.getByRole("alert");
  await expect(feedback).toBeVisible();
  await expect(
    page.getByText(await feedback.innerText(), { exact: true }),
  ).toHaveCount(1);
  await expect(url).toHaveValue("ws://[::1]:43100/device");
  await dialog.screenshot({
    path: info.outputPath("websocket-client-narrow.png"),
  });
  await url.press("Escape");
  await page.getByRole("button", { name: "放弃并继续", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(connection).toBeFocused();
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
