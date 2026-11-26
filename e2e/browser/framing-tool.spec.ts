import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import {
  decodeModbusFrame,
  encodeModbusFrame,
} from "../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { xyCaptureFixture } from "./xy-capture.fixture";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("Modbus registers watch confirmed values and write the selected register words", async ({
  page,
}) => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-modbus/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid master manifest fixture");
  const action = manifest.contributes.actions.find(
    (item) => item.actionId === "swb.reference.modbus.transaction",
  );
  if (!action) throw new Error("Missing Modbus catalog action");
  function fixtureResult(id: string, pdu: object, exceptionCode?: number) {
    const wire = encodeModbusFrame("rtu", "response", { unitId: 1, pdu });
    const fileRef = {
      hostId: "workbench-gui-host",
      kind: "plugin_result",
      id,
      revision: "1",
    };
    const point = (eventSeq: string, monoNs: string) => ({
      eventSeq,
      monoNs,
      clockId: "register-clock",
      source: "host_read",
      resolutionNs: "1000000",
    });
    const response = {
      bytesBase64: Buffer.from(wire).toString("base64"),
      source: {
        hostId: fileRef.hostId,
        sessionId: "session",
        sessionEpoch: "1",
        direction: "rx",
        eventStart: "7",
        eventEnd: "8",
        byteStart: "12",
        byteEnd: String(12 + wire.length),
      },
      timing: {
        clockId: "register-clock",
        txMonoNs: "100000000",
        rxMonoNs: "105000000",
        elapsedNs: "5000000",
      },
      ...(exceptionCode !== undefined && { exceptionCode }),
    };
    const outcome =
      exceptionCode === undefined ? "matched" : "device_exception";
    const attempt = {
      operationId: `${id}-tx`,
      outcome,
      ignoredFrames: 0,
      response,
      trace: {
        tx: point("6", "100000000"),
        rxFirst: point("7", "105000000"),
        rxLast: point("7", "105000000"),
      },
    };
    const body = Buffer.from(
      JSON.stringify({ ...attempt, attempts: [attempt] }),
    );
    return {
      fileRef,
      offset: "0",
      nextOffset: String(body.length),
      totalBytes: String(body.length),
      atEnd: true,
      bytesBase64: body.toString("base64"),
      fingerprint: createHash("sha256").update(body).digest("hex"),
    };
  }
  await page.setViewportSize({ width: 720, height: 650 });
  await seedWorkbenchFixture(page, {
    language: "en",
    framing: {
      action,
      page: fixtureResult("register-read", {
        functionCode: 3,
        values: [0x5678, 0x1234, 1, 0],
      }),
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  const heading = dialog.getByText(en["workbench.registers.title"], {
    exact: true,
  });
  await heading.click();
  const view = heading.locator("..");
  await view
    .getByRole("combobox", { name: en["workbench.registers.base"] })
    .click();
  await page
    .getByRole("option", { name: en["workbench.registers.one"], exact: true })
    .click();
  await view
    .getByRole("spinbutton", {
      name: en["workbench.registers.address"],
      exact: true,
    })
    .fill("101");
  await view
    .getByRole("combobox", { name: en["workbench.registers.format"] })
    .click();
  await page
    .getByRole("option", {
      name: en["workbench.registers.format.u32"],
      exact: true,
    })
    .click();
  await view
    .getByRole("combobox", { name: en["workbench.registers.order"] })
    .click();
  await page.getByRole("option", { name: "CDAB", exact: true }).click();
  await view
    .getByRole("spinbutton", { name: en["workbench.registers.count"] })
    .fill("2");
  await view
    .getByRole("spinbutton", { name: en["workbench.registers.interval"] })
    .fill("250");
  await expect(
    view.getByText("PDU start 100 · 4 register words", { exact: true }),
  ).toBeVisible();
  const watch = view.getByRole("button", {
    name: en["workbench.registers.watch"],
  });
  const transactions = () =>
    page.evaluate(() =>
      window.workbenchFixture.invocations.filter(
        (item) => item.actionId === "swb.reference.modbus.transaction",
      ),
    );
  await watch.click();
  const data = view.getByRole("table", {
    name: en["workbench.registers.lastRead"],
  });
  await expect(
    data.getByRole("row", { name: "101 5678 1234 305419896" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await transactions()).length)
    .toBeGreaterThanOrEqual(2);
  await view
    .getByRole("button", { name: en["workbench.registers.stop"] })
    .click();
  await expect(watch).toBeEnabled();
  const settledCount = (await transactions()).length;
  await page.waitForTimeout(400);
  expect((await transactions()).length).toBe(settledCount);
  const first = (await transactions())[0]!;
  expect(first.params).toMatchObject({
    transport: "rtu",
    retryLimit: 0,
    includeTrace: true,
  });
  expect(
    decodeModbusFrame(
      "rtu",
      "request",
      Buffer.from(String(first.params.requestBase64), "base64"),
    ).packet.pdu,
  ).toEqual({ functionCode: 3, address: 100, quantity: 4 });

  await page.evaluate(
    (result) => window.workbenchFixture.setFramingResult(result),
    fixtureResult("register-write", {
      functionCode: 16,
      address: 102,
      quantity: 2,
    }),
  );
  await view
    .getByRole("spinbutton", { name: en["workbench.registers.writeAddress"] })
    .fill("103");
  await view
    .getByRole("textbox", { name: en["workbench.registers.writeValue"] })
    .fill("305419896");
  await expect(
    view.getByText("PDU address 102 · wire words (HEX)", { exact: false }),
  ).toBeVisible();
  await view.getByRole("button", { name: "Write value · FC16" }).click();
  await expect(
    view.getByText(en["workbench.registers.writeConfirmed"], { exact: false }),
  ).toBeVisible();
  await expect(data).toHaveCount(0);
  const written = (await transactions()).at(-1)!;
  expect(written.params.retryLimit).toBe(0);
  expect(
    decodeModbusFrame(
      "rtu",
      "request",
      Buffer.from(String(written.params.requestBase64), "base64"),
    ).packet.pdu,
  ).toEqual({ functionCode: 16, address: 102, values: [0x5678, 0x1234] });

  await page.evaluate(
    (result) => window.workbenchFixture.setFramingResult(result),
    fixtureResult(
      "register-exception",
      { functionCode: 4, exceptionCode: 2 },
      2,
    ),
  );
  await view
    .getByRole("combobox", { name: en["workbench.registers.table"] })
    .click();
  await page
    .getByRole("option", { name: en["workbench.registers.input"], exact: true })
    .click();
  await expect(
    view.getByRole("button", { name: "Write value · FC16" }),
  ).toHaveCount(0);
  await view.getByRole("button", { name: "Read once · FC04" }).click();
  await expect(view.getByRole("status")).toContainText(/Device exception.*2/);
  await expect(data).toHaveCount(0);
});

test("the live Modbus slave uses its Host session and commits the settled model", async ({
  page,
}) => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-modbus-slave/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid slave manifest fixture");
  const [action] = manifest.contributes.actions;
  if (!action) throw new Error("Missing live slave action");
  const fileRef = {
    hostId: "workbench-gui-host",
    kind: "plugin_result",
    id: "slave-fixture",
    revision: "1",
  };
  const encoded = Buffer.from(
    JSON.stringify({
      reason: "request_limit",
      receivedBytes: 12,
      pendingFrame: false,
      model: {
        unitId: 1,
        tables: { holdingRegisters: [{ start: 0, values: [12, 258] }] },
        faults: [],
      },
      processed: [
        {
          status: "replied",
          requestBase64: "ABUAAAAGAQYAAQEC",
          responseBase64: "ABUAAAAGAQYAAQEC",
          tx: { operationId: "slave-reply", confirmed: true },
          time: {
            clockId: "fixture",
            sourceMonoNs: "4000000",
            precision: {
              source: "host_read",
              resolutionNs: "1000000",
              syncMethod: "fixture",
            },
          },
          source: {
            hostId: fileRef.hostId,
            sessionId: "session",
            sessionEpoch: "1",
            direction: "rx",
            eventStart: "4",
            eventEnd: "6",
            byteStart: "10",
            byteEnd: "22",
          },
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 720, height: 650 });
  await seedWorkbenchFixture(page, {
    language: "en",
    framing: {
      action,
      page: {
        fileRef,
        offset: "0",
        nextOffset: String(encoded.length),
        totalBytes: String(encoded.length),
        bytesBase64: encoded.toString("base64"),
        fingerprint: createHash("sha256").update(encoded).digest("hex"),
        atEnd: true,
      },
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  const heading = dialog.getByText(en["workbench.modbusServer.title"], {
    exact: true,
  });
  await heading.click();
  const slave = heading.locator("..");
  const live = slave.getByRole("region", {
    name: en["workbench.modbusServer.live.title"],
  });
  const start = live.getByRole("button", {
    name: en["workbench.modbusServer.live.start"],
  });
  await expect(start).toBeDisabled();
  await slave
    .getByRole("combobox", { name: en["workbench.modbus.transport"] })
    .click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  await slave
    .getByRole("button", { name: en["workbench.modbusServer.example"] })
    .click();
  await live
    .getByRole("spinbutton", { name: en["workbench.modbusServer.live.limit"] })
    .fill("1");
  await start.click();
  await expect(live.getByRole("status")).toContainText(
    en["workbench.modbusServer.live.reason.request_limit"],
  );
  await expect(live.getByRole("listitem")).toContainText("[10, 22)");
  await expect(live.getByRole("listitem")).toContainText(
    en["workbench.modbusServer.live.txConfirmed"],
  );
  await slave
    .getByText(en["workbench.modbusServer.current"], { exact: true })
    .click();
  await expect(slave.locator("pre")).toContainText("258");
  const invocation = await page.evaluate(() =>
    window.workbenchFixture.invocations.find(
      (item) => item.actionId === "swb.reference.modbus.slave.serve",
    ),
  );
  expect(invocation).toMatchObject({
    target: {
      hostId: fileRef.hostId,
      kind: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
    params: {
      transport: "tcp",
      requestLimit: 1,
      durationMs: 15000,
      replyDelayMs: 0,
    },
  });

  await page.evaluate(() => window.workbenchFixture.holdNextFraming());
  await start.click();
  await live
    .getByRole("button", { name: en["workbench.modbusServer.live.stop"] })
    .click();
  await expect(live.getByRole("status")).toHaveText(
    en["workbench.modbusServer.live.stopping"],
  );
  await expect(start).toBeDisabled();
  await page.evaluate(() =>
    window.workbenchFixture.settleFramingCancellation(),
  );
  await expect(live.getByRole("status")).toHaveText(
    en["workbench.modbusServer.live.cancelled"],
  );
  await expect(start).toBeEnabled();
  await expect(slave.locator("pre")).toContainText("258");
});

test("the Modbus master timeline uses the selected Host session and shows split receive evidence", async ({
  page,
}) => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-modbus/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid Modbus catalog fixture");
  const action = manifest.contributes.actions.find(
    (item) => item.actionId === "swb.reference.modbus.transaction",
  );
  if (!action) throw new Error("Missing Modbus catalog action");
  const fileRef = {
    hostId: "workbench-gui-host",
    kind: "plugin_result",
    id: "modbus-timeline-fixture",
    revision: "1",
  };
  const clockId = "modbus-fixture-clock";
  const point = (eventSeq: string, monoNs: string) => ({
    eventSeq,
    monoNs,
    clockId,
    source: "host_read",
    resolutionNs: "1000000",
  });
  const received = {
    bytesBase64: Buffer.from([0, 2, 0, 0, 0, 5, 1, 3, 2, 0x12, 0x34]).toString(
      "base64",
    ),
    source: {
      hostId: fileRef.hostId,
      sessionId: "session",
      sessionEpoch: "1",
      direction: "rx",
      eventStart: "7",
      eventEnd: "9",
      byteStart: "11",
      byteEnd: "22",
    },
    timing: {
      clockId,
      txMonoNs: "1200000000",
      rxMonoNs: "1227000000",
      elapsedNs: "27000000",
      txPrecision: {
        source: "host_read",
        resolutionNs: "1000000",
        syncMethod: "fixture",
      },
      rxPrecision: {
        source: "host_read",
        resolutionNs: "1000000",
        syncMethod: "fixture",
      },
    },
  };
  const encoded = Buffer.from(
    JSON.stringify({
      operationId: "second-send",
      outcome: "matched",
      ignoredFrames: 1,
      response: received,
      attempts: [
        {
          operationId: "first-send",
          outcome: "response_timeout",
          ignoredFrames: 0,
          requestTransactionId: 1,
          trace: { tx: point("4", "1000000") },
        },
        {
          operationId: "second-send",
          outcome: "matched",
          ignoredFrames: 1,
          requestTransactionId: 2,
          response: received,
          trace: {
            tx: point("6", "1200000000"),
            rxFirst: point("7", "1220500000"),
            rxLast: point("8", "1227000000"),
          },
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 720, height: 650 });
  await seedWorkbenchFixture(page, {
    language: "en",
    framing: {
      action,
      page: {
        fileRef,
        offset: "0",
        nextOffset: String(encoded.length),
        totalBytes: String(encoded.length),
        bytesBase64: encoded.toString("base64"),
        fingerprint: createHash("sha256").update(encoded).digest("hex"),
        atEnd: true,
      },
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  const title = dialog.getByText(en["workbench.timeline.title"], {
    exact: true,
  });
  await title.click();
  const timeline = title.locator("..");
  await timeline
    .getByRole("combobox", { name: en["workbench.modbus.transport"] })
    .click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  const request = timeline.getByRole("textbox", {
    name: en["workbench.modbus.requestFrame"],
  });
  const send = timeline.getByRole("button", {
    name: en["workbench.timeline.send"],
  });
  await request.fill("00");
  await send.click();
  await expect(request).toBeFocused();
  await expect(timeline.getByRole("alert")).toHaveText(
    en["workbench.timeline.invalidRequest"],
  );
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.invocations.some(
        (item) => item.actionId === "swb.reference.modbus.transaction",
      ),
    ),
  ).toBe(false);
  await timeline
    .getByRole("button", { name: en["workbench.modbus.example"] })
    .click();
  await timeline
    .getByRole("combobox", { name: en["workbench.timeline.retry"] })
    .click();
  await page.getByRole("option", { name: "1", exact: true }).click();
  await send.click();
  const result = timeline.getByRole("region", {
    name: en["workbench.timeline.result"],
  });
  await expect(
    result.getByRole("heading", {
      name: /Attempt 1.*Response timed out.*ID 1/,
    }),
  ).toBeVisible();
  await expect(
    result.getByRole("heading", { name: /Attempt 2.*Matched response.*ID 2/ }),
  ).toBeVisible();
  await expect(
    result.getByText("20.500–27.000 ms", { exact: true }),
  ).toBeVisible();
  await expect(
    result.getByText("1199.000 ms · #6", { exact: true }),
  ).toBeVisible();
  await expect(result.getByText("6.500 ms", { exact: true })).toBeVisible();
  await expect(
    result.getByText("#7–#8 · [11, 22)", { exact: true }),
  ).toBeVisible();
  const invocation = await page.evaluate(() =>
    window.workbenchFixture.invocations.find(
      (item) => item.actionId === "swb.reference.modbus.transaction",
    ),
  );
  expect(invocation).toMatchObject({
    target: {
      hostId: fileRef.hostId,
      kind: "session",
      sessionId: "session",
      sessionEpoch: "1",
    },
    executionMode: "independent",
    params: {
      transport: "tcp",
      includeTrace: true,
      retryLimit: 1,
      responseTimeoutMs: 1000,
    },
  });
});

test("the framing tool follows the selected session and points to the catalog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  const menu = page.getByRole("button", { name: en["workbench.tools.more"] });
  const name = en["workbench.tools.framing"];
  const dialog = page.getByRole("dialog", { name });
  const openFraming = async () => {
    await menu.click();
    await page.getByRole("menuitem", { name }).click();
    await expect(dialog).toBeVisible();
  };
  await openFraming();
  await expect(
    dialog.getByText(en["workbench.framing.selectSession"]),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();

  await page
    .getByRole("button", {
      name: `${en["workbench.open"]} Virtual serial`,
      exact: true,
    })
    .click();
  await openFraming();
  await expect(
    dialog.getByText(en["workbench.framing.unavailable"]),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: en["workbench.framing.openPlugins"] }),
  ).toHaveAttribute("href", "#/plugins");
  const title = dialog.getByText(en["workbench.timeline.title"], {
    exact: true,
  });
  await title.click();
  const timeline = title.locator("..");
  await expect(
    timeline.getByText(en["workbench.timeline.unavailable"]),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: en["workbench.timeline.send"] }),
  ).toHaveCount(0);
});

test("the packet editor constructs and reads back numeric fields without a session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await expect(
    dialog.getByText(en["workbench.framing.selectSession"]),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: en["workbench.fields.numericExample"] })
    .click();
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  const sample = dialog.getByRole("textbox", { name: "sample", exact: true });
  const reading = dialog.getByRole("textbox", { name: "reading", exact: true });
  await expect(sample).toHaveAccessibleDescription(
    "Signed 16-bit integer · little-endian",
  );
  await expect(reading).toHaveAccessibleDescription(
    "32-bit float · big-endian",
  );
  await sample.fill("-12");
  await reading.fill("1.5");
  const preview = dialog.getByRole("button", {
    name: en["workbench.fields.generate"],
  });
  const generated = dialog.getByLabel(en["workbench.fields.generated"], {
    exact: true,
  });
  await preview.click();
  await expect(generated).toHaveText("F4 FF 3F C0 00 00");
  await expect(dialog.getByRole("row", { name: /reading/ })).toContainText(
    "1.5",
  );
  await sample.fill("-32769");
  await expect(generated).toHaveCount(0);
  await preview.click();
  await expect(dialog.getByRole("alert")).toContainText("values.sample");
  await expect(sample).toHaveAttribute("aria-invalid", "true");
  await sample.fill("-32768");
  await preview.click();
  await expect(generated).toHaveText("00 80 3F C0 00 00");
  await expect(dialog.getByRole("row", { name: /sample/ })).toContainText(
    "-32768",
  );
  await dialog
    .getByRole("combobox", { name: en["workbench.fields.format"] })
    .click();
  await page.getByRole("option", { name: "YAML", exact: true }).click();
  await expect(generated).toHaveCount(0);
  const definition = dialog.getByLabel(en["workbench.fields.definition"]);
  const yaml = [
    'version: "1"',
    "byteLength: 1",
    "fields:",
    "  - id: value",
    "    kind: bytes",
    "    byteOffset: 0",
    "    width: 2",
  ].join("\n");
  await definition.fill(yaml);
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "fields[0].width at line 7, column 5",
  );
  await definition.fill(yaml.replace("width: 2", "width: 1"));
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  await dialog.getByRole("textbox", { name: "value", exact: true }).fill("FF");
  await preview.click();
  await expect(generated).toHaveText("FF");

  await definition.fill(
    [
      'version: "1"',
      "byteLength: 1",
      "fields:",
      "  - id: sensor",
      "    kind: integer",
      "    byteOffset: 0",
      "    width: 1",
      "    order: big",
      "    unit: V",
      "    calibration:",
      "      kind: table",
      "      revision: sensor-2",
      "      interpolation: linear",
      "      points:",
      '        - raw: "3"',
      '          value: "1"',
      '        - raw: "9"',
      '          value: "4"',
    ].join("\n"),
  );
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  const physical = dialog.getByRole("textbox", {
    name: "sensor (V)",
    exact: true,
  });
  await expect(physical).toHaveValue("");
  await physical.fill("2.5");
  await preview.click();
  await expect(generated).toHaveText("06");
  const calibrated = dialog.getByRole("row", { name: /sensor/ });
  await expect(calibrated).toContainText("2.5 V");
  await expect(calibrated).toContainText("Raw 6 · calibration sensor-2");
});

for (const { width, height, language, theme, t } of [
  { width: 420, height: 460, language: "zh", theme: "dark", t: zhCN },
  { width: 1240, height: 760, language: "en", theme: "light", t: en },
] as const) {
  test(`frame templates trace named variables and checksum at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await seedWorkbenchFixture(page, { language, theme });
    await page.goto("./#/");
    const direct = page.getByRole("button", {
      name: t["workbench.tools.framing"],
      exact: true,
    });
    if (await direct.isVisible()) await direct.click();
    else {
      await page
        .getByRole("button", { name: t["workbench.tools.more"], exact: true })
        .click();
      await page
        .getByRole("menuitem", {
          name: t["workbench.tools.framing"],
          exact: true,
        })
        .click();
    }
    const dialog = page.getByRole("dialog", {
      name: t["workbench.tools.framing"],
      exact: true,
    });
    await dialog
      .getByText(t["workbench.frameTemplate.title"], { exact: true })
      .click();
    const form = dialog.locator("form.workbench-frame-template");
    const header = form.getByRole("textbox", {
      name: t["workbench.frameTemplate.header"],
      exact: true,
    });
    await header.scrollIntoViewIfNeeded();
    await expect(header).toHaveValue("AA 55");
    const geometry = await form.evaluate((element) => {
      const controls = [
        ...element.querySelectorAll("input, [data-slot='select-trigger']"),
      ];
      const heights = controls.map(
        (node) => node.getBoundingClientRect().height,
      );
      const firstControls = element.querySelectorAll(
        ".workbench-frame-template-controls > label:first-child :is(input, [data-slot='select-trigger']), fieldset > legend",
      );
      const leftEdges = Array.from(
        firstControls,
        (node) => node.getBoundingClientRect().left,
      );
      const labels = [
        ...element.querySelectorAll<HTMLElement>("[data-slot='select-value']"),
      ];
      return {
        contained: element.scrollWidth <= element.clientWidth + 1,
        consistent: Math.max(...heights) - Math.min(...heights) <= 1,
        aligned: Math.max(...leftEdges) - Math.min(...leftEdges) <= 1,
        labelsFit: labels.every(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      };
    });
    expect(geometry).toEqual({
      contained: true,
      consistent: true,
      aligned: true,
      labelsFit: true,
    });
    await dialog.screenshot({
      path: info.outputPath("frame-template-controls.png"),
    });
    const preview = form.getByRole("button", {
      name: t["workbench.frameTemplate.preview"],
    });
    const result = form.getByRole("textbox", {
      name: t["workbench.frameTemplate.result"],
    });
    const payload = form.getByRole("textbox", {
      name: t["workbench.frameTemplate.variableValue"].replace(
        "{name}",
        "data",
      ),
    });
    await preview.click();
    await expect(result).toHaveValue("AA 55 03 02 01 10 20 30 03 0D");
    await expect(
      form.getByRole("table").getByText("[5, 8)", { exact: true }),
    ).toBeVisible();
    const trace = form.getByRole("region", {
      name: t["workbench.frameTemplate.trace"],
    });
    expect(
      await trace.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(width === 420);
    await payload.fill("F");
    await expect(result).toHaveCount(0);
    await preview.click();
    await expect(payload).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toContainText("values.payload");
    await payload.fill("10 20 30");
    await preview.click();
    await result.scrollIntoViewIfNeeded();
    await dialog.screenshot({
      path: info.outputPath("frame-template-result.png"),
    });

    await form
      .getByRole("combobox", { name: t["workbench.frameTemplate.mode"] })
      .press("ArrowDown");
    await page
      .getByRole("option", {
        name: t["workbench.frameTemplate.decode"],
        exact: true,
      })
      .click();
    const source = form.getByRole("textbox", {
      name: t["workbench.frameTemplate.source"],
    });
    const verify = form.getByRole("button", {
      name: t["workbench.frameTemplate.decode"],
    });
    await source.fill("AA 55 03 02 01 10 20 30 04 0D");
    await verify.click();
    await expect(form.getByRole("alert")).toHaveText(
      t["workbench.frameTemplate.invalidChecksum"],
    );
    await source.fill("AA 55 03 02 01 10 20 30 03 0D");
    await verify.click();
    await expect(result).toHaveValue("AA 55 03 02 01 10 20 30 03 0D");
    await expect(
      form.getByRole("table").getByText("serial = 258", { exact: true }),
    ).toBeVisible();
    const jsonLabel = t["workbench.frameTemplate.templateJson"];
    await form.getByText(jsonLabel, { exact: true }).click();
    const json = form.getByRole("textbox", { name: jsonLabel });
    const definition = await json.inputValue();
    const future = definition.replace('"version": "1"', '"version": "2"');
    const apply = form.getByRole("button", {
      name: t["workbench.frameTemplate.apply"],
    });
    await json.fill(future);
    await apply.click();
    await expect(json).toHaveValue(future);
    await expect(json).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toContainText("json.version");
    await expect(header).toHaveValue("AA 55");
    await json.fill(definition.replace('"AA 55"', '"AA 56"'));
    await apply.click();
    await expect(json).not.toHaveAttribute("aria-invalid", "true");
    await expect(header).toHaveValue("AA 56");
    expect(
      await page.evaluate(
        () =>
          window.workbenchFixture.invocations.filter(
            ({ actionId }) => actionId === "session.tx",
          ).length,
      ),
    ).toBe(0);
  });
}

test("CRC recognition asks for independent samples and validates the wire byte order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog.getByText(en["workbench.crc.title"], { exact: true }).click();
  const width = dialog.getByRole("combobox", {
    name: en["workbench.crc.width"],
  });
  await width.click();
  await page.getByRole("option", { name: "16 bits", exact: true }).click();
  const first = dialog.getByRole("group", { name: "Sample 1", exact: true });
  const second = dialog.getByRole("group", { name: "Sample 2", exact: true });
  const input = (group: typeof first, key: "bytes" | "checksum") =>
    group.getByRole("textbox", { name: en[`workbench.crc.${key}`] });
  const payload = "31 32 33 34 35 36 37 38 39";
  await input(first, "bytes").fill(payload);
  await input(first, "checksum").fill("37 4B");
  const analyze = dialog.getByRole("button", {
    name: en["workbench.crc.analyze"],
  });
  await analyze.click();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.crc.moreSamples"],
  );
  const modbus = dialog.getByRole("row", { name: /CRC-16\/MODBUS/ });
  await expect(modbus).toContainText("little-endian");
  await expect(modbus).toContainText("0x8005");

  await dialog.getByRole("button", { name: en["workbench.crc.add"] }).click();
  await expect(modbus).toHaveCount(0);
  await input(second, "bytes").fill(payload);
  await input(second, "checksum").fill("374B");
  await analyze.click();
  await expect(dialog.getByText(/Repeated samples 1/)).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.crc.moreSamples"],
  );
  await input(second, "checksum").fill("374A");
  await analyze.click();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.crc.contradictory"],
  );

  await input(second, "bytes").fill("01 03 00 00 00 0A");
  await input(second, "checksum").fill("C5 CD");
  await analyze.click();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.crc.matched"],
  );
  await expect(modbus).toBeVisible();
  await dialog
    .getByRole("combobox", { name: en["workbench.crc.order"] })
    .click();
  await page.getByRole("option", { name: "big-endian", exact: true }).click();
  await analyze.click();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.crc.noMatch"],
  );
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("Modbus frames verify RTU and construct ASCII and TCP without sending", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog.getByText(en["workbench.modbus.title"], { exact: true }).click();
  const frame = dialog.getByRole("textbox", {
    name: en["workbench.modbus.frame"],
  });
  const transport = dialog.getByRole("combobox", {
    name: en["workbench.modbus.transport"],
  });
  const verify = dialog.getByRole("button", {
    name: en["workbench.modbus.verify"],
    exact: true,
  });
  await frame.fill("01 03 00 00 00 0A C5 CC");
  await verify.click();
  await expect(dialog.getByRole("alert")).toContainText("frame.crc");
  await frame.fill("01 03 00 00 00 0A C5 CD");
  await verify.click();
  await expect(dialog.getByRole("status")).toHaveText(
    en["workbench.modbus.verified"],
  );
  await expect(dialog.getByLabel(en["workbench.modbus.packet"])).toContainText(
    '"quantity": 10',
  );
  await dialog
    .getByRole("button", { name: en["workbench.modbus.edit"] })
    .click();
  await transport.click();
  await page.getByRole("option", { name: "ASCII", exact: true }).click();
  const build = dialog.getByRole("button", {
    name: en["workbench.modbus.build"],
  });
  const generated = dialog.getByLabel(en["workbench.modbus.generated"]);
  await build.click();
  await expect(generated).toHaveText(
    "3A 30 31 30 33 30 30 30 30 30 30 30 41 46 32 0D 0A",
  );
  await expect(dialog.getByText(/:01030000000AF2/)).toBeVisible();
  await transport.click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  await build.click();
  await expect(dialog.getByRole("alert")).toContainText("packet.transactionId");
  const packet = dialog.getByRole("textbox", {
    name: en["workbench.modbus.packet"],
  });
  await packet.fill(
    JSON.stringify({
      unitId: 1,
      transactionId: 1,
      pdu: { functionCode: 3, address: 0, quantity: 10 },
    }),
  );
  await build.click();
  await expect(generated).toHaveText("00 01 00 00 00 06 01 03 00 00 00 0A");
  await dialog
    .getByRole("button", { name: en["workbench.modbus.verifyGenerated"] })
    .click();
  await verify.click();
  await expect(dialog.getByLabel(en["workbench.modbus.packet"])).toContainText(
    '"transactionId": 1',
  );
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("the packet editor opens an authorized definition file and discards late reads", async ({
  page,
}) => {
  const yaml = [
    'version: "1"',
    "byteLength: 1",
    "fields:",
    "  - id: value",
    "    kind: bytes",
    "    byteOffset: 0",
    "    width: 2",
  ].join("\n");
  function source(id: string, name: string, bytes: Buffer) {
    const reference = {
      hostId: "workbench-gui-host",
      kind: "file" as const,
      id,
      revision: "1",
    };
    const length = String(bytes.length);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    return {
      selected: { reference, name, length, mime: "application/octet-stream" },
      metadata: {
        fileRef: reference,
        purpose: "read_file" as const,
        length,
        fingerprint,
      },
      page: {
        fileRef: reference,
        offset: "0",
        nextOffset: length,
        totalBytes: length,
        bytesBase64: bytes.toString("base64"),
        fingerprint,
        atEnd: true,
      },
    };
  }
  const first = source(
    "definition-yaml",
    "example.YML",
    Buffer.from("\uFEFF" + yaml.replace(/\n/g, "\r\n")),
  );
  const corrupt = source(
    "definition-changed",
    "changed.yaml",
    Buffer.from(yaml),
  );
  corrupt.page.bytesBase64 = Buffer.from(
    yaml.replace("width: 2", "width: 1"),
  ).toString("base64");
  await seedWorkbenchFixture(page, {
    language: "en",
    definitionFiles: [
      first,
      { selected: { ...first.selected, length: "49156" } },
      corrupt,
      {
        ...source("definition-late", "late.yaml", Buffer.from(yaml)),
        holdRead: true,
      },
    ],
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  const open = dialog.getByRole("button", {
    name: en["workbench.fields.openFile"],
    exact: true,
  });
  const definition = dialog.getByRole("textbox", {
    name: en["workbench.fields.definition"],
  });
  await open.click();
  await expect(dialog.getByRole("status")).toContainText("example.YML");
  await expect(definition).toHaveValue(yaml);
  await expect(
    dialog.getByRole("combobox", { name: en["workbench.fields.format"] }),
  ).toHaveText("YAML");
  await expect(dialog.getByRole("alert")).toContainText(
    "fields[0].width at line 7, column 5",
  );

  const fixed = yaml.replace("width: 2", "width: 1");
  await definition.fill(fixed);
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  await dialog.getByRole("textbox", { name: "value", exact: true }).fill("5A");
  await dialog
    .getByRole("button", { name: en["workbench.fields.generate"] })
    .click();
  const generated = dialog.getByLabel(en["workbench.fields.generated"], {
    exact: true,
  });
  await expect(generated).toHaveText("5A");
  await open.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["workbench.fields.fileSize"],
  );
  await expect(generated).toHaveText("5A");
  await open.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en["workbench.fields.fileChanged"],
  );
  await expect(definition).toHaveValue(fixed);

  await open.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.workbenchFixture.hostQueries.filter(
            (query) => query === "file.read",
          ).length,
      ),
    )
    .toBe(3);
  const localDraft = fixed + "\n# Continue editing";
  await definition.fill(localDraft);
  await page.evaluate(() => window.workbenchFixture.releaseDefinitionRead());
  await expect(open).toBeEnabled();
  await expect(definition).toHaveValue(localDraft);
  await open.click();
  await expect(open).toBeEnabled();
  await expect(definition).toHaveValue(localDraft);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.filePickerCalls.map((call) => call.role),
    ),
  ).toEqual(Array(5).fill("protocolDefinitionSource"));
});

test("Modbus compares offline samples and keeps both drafts across operations", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog.getByText(en["workbench.modbus.title"], { exact: true }).click();
  const mode = dialog.getByRole("combobox", {
    name: en["workbench.modbus.mode"],
  });
  const selectMode = async (name: string) => {
    await mode.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await selectMode(en["workbench.modbus.compare"]);
  await dialog
    .getByRole("combobox", { name: en["workbench.modbus.transport"] })
    .click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  const request = dialog.getByRole("textbox", {
    name: en["workbench.modbus.requestFrame"],
  });
  const response = dialog.getByRole("textbox", {
    name: en["workbench.modbus.responseFrame"],
  });
  const compare = dialog.getByRole("button", {
    name: en["workbench.modbus.compare"],
  });
  await dialog
    .getByRole("button", { name: en["workbench.modbus.example"] })
    .click();
  const sampleRequest = await request.inputValue();
  const sampleResponse = await response.inputValue();
  await compare.click();
  await expect(
    dialog.getByText(en["workbench.modbus.result.matched"], { exact: true }),
  ).toBeVisible();
  await selectMode(en["workbench.modbus.decode"]);
  await selectMode(en["workbench.modbus.compare"]);
  await expect(request).toHaveValue(sampleRequest);
  await expect(response).toHaveValue(sampleResponse);

  await response.fill("00 01 00 00 00 03 FF 83 02");
  await compare.click();
  await expect(
    dialog.getByText(en["workbench.modbus.mismatch.unit-id"], { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: en["workbench.modbus.routing"] })
    .click();
  await page
    .getByRole("option", { name: en["workbench.modbus.direct"] })
    .click();
  await compare.click();
  await expect(
    dialog.getByText("The device returned Modbus exception 2.", {
      exact: true,
    }),
  ).toBeVisible();

  await response.fill("00 01");
  await compare.click();
  await expect(response).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toContainText(
    "response.frame.length",
  );
  await response.clear();
  await compare.click();
  await expect(
    dialog.getByText(en["workbench.modbus.result.missing-response"], {
      exact: true,
    }),
  ).toBeVisible();
});

test("Modbus simulator retains a successful write across requests and resets to its initial model", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog
    .getByText(en["workbench.modbusServer.title"], { exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: en["workbench.modbus.transport"] })
    .click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  await dialog
    .getByRole("button", { name: en["workbench.modbusServer.example"] })
    .click();
  const request = dialog.getByRole("textbox", {
    name: en["workbench.modbus.requestFrame"],
  });
  const response = dialog.getByLabel(en["workbench.modbus.responseFrame"]);
  const simulate = dialog.getByRole("button", {
    name: en["workbench.modbusServer.run"],
  });
  await simulate.click();
  await expect(response).toHaveText("00 01 00 00 00 06 01 06 00 01 01 02");
  await dialog
    .getByText(en["workbench.modbusServer.current"], { exact: true })
    .click();
  await expect(dialog.locator("pre")).toContainText("258");

  const read = "00 02 00 00 00 06 01 03 00 01 00 01";
  await request.fill(read);
  await simulate.click();
  await expect(response).toHaveText("00 02 00 00 00 05 01 03 02 01 02");
  await request.fill("00 03 00 00 00 06 01 03 00 05 00 01");
  await simulate.click();
  await expect(response).toHaveText("00 03 00 00 00 03 01 83 02");
  await expect(
    dialog.getByText("The simulated server returned exception 2."),
  ).toBeVisible();

  await dialog
    .getByRole("button", { name: en["workbench.modbusServer.reset"] })
    .click();
  await request.fill(read);
  await simulate.click();
  await expect(response).toHaveText("00 02 00 00 00 05 01 03 02 00 00");
});

test("NMEA verifies mixed samples and locates raw fields and checksum errors", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog.getByText(en["workbench.nmea.title"], { exact: true }).click();
  const input = dialog.getByRole("textbox", {
    name: en["workbench.nmea.input"],
  });
  const parse = dialog.getByRole("button", {
    name: en["workbench.nmea.parse"],
  });
  const selectedText = () =>
    input.evaluate((element: HTMLTextAreaElement) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    );
  await dialog
    .getByRole("button", { name: en["workbench.nmea.example"] })
    .click();
  const [gga, rmc] = (await input.inputValue()).split("\n");
  if (!gga || !rmc) throw new Error("Expected both NMEA example sentences");
  await input.fill([gga, "", gga.slice(0, -2) + "00", rmc].join("\n"));
  await parse.click();
  const report = dialog.getByRole("region", {
    name: en["workbench.nmea.results"],
  });
  await expect(report.getByRole("status")).toHaveText(
    "GPGGA passed the XOR check (47).",
  );
  const latitude = report.getByRole("row").filter({ hasText: "latitude" });
  await expect(latitude).toContainText("48.1173 deg");
  await latitude
    .getByRole("button", { name: "Locate latitude, byte range [14, 24)" })
    .click();
  await expect(input).toBeFocused();
  expect(await selectedText()).toBe("4807.038,N");

  const line = report.getByRole("combobox", {
    name: en["workbench.nmea.resultLine"],
  });
  await line.click();
  await page
    .getByRole("option", { name: "Line 3 · Invalid", exact: true })
    .click();
  await expect(report.getByRole("status")).toHaveText(
    "Check checksum on line 3.",
  );
  await report
    .getByRole("button", { name: en["workbench.nmea.locate"] })
    .click();
  await expect(input).toBeFocused();
  expect(await selectedText()).toBe("00");
  await line.click();
  await page
    .getByRole("option", { name: "Line 4 · GPRMC", exact: true })
    .click();
  await expect(
    report.getByRole("row").filter({ hasText: "utcDate" }),
  ).toContainText("23-03-94");
});

test("AT responses separate interleaved URCs, numeric results and SMS bodies", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog.getByText(en["workbench.at.title"], { exact: true }).click();
  const command = dialog.getByRole("textbox", {
    name: en["workbench.at.command"],
  });
  const sample = dialog.getByRole("textbox", { name: en["workbench.at.text"] });
  const parse = dialog.getByRole("button", { name: en["workbench.at.parse"] });
  await dialog
    .getByRole("button", { name: en["workbench.at.example"] })
    .click();
  await expect(command).toHaveValue("AT+CREG?");
  await parse.click();
  const report = dialog.getByRole("region", {
    name: en["workbench.at.results"],
  });
  await expect(report.getByRole("status")).toHaveText(
    en["workbench.at.state.complete"],
  );
  const row = (text: string) =>
    report.getByRole("row").filter({ hasText: text });
  await expect(row("+CREG: 5")).toContainText(en["workbench.at.kind.urc"]);
  await expect(row("+CREG: 2,5")).toContainText(
    en["workbench.at.kind.response"],
  );
  await expect(row("OK")).toContainText(en["workbench.at.kind.result"]);

  await sample.fill('+CMT: "+123",,"26/11/24,08:00:00+32"\nOK');
  await parse.click();
  await expect(report.getByRole("status")).toHaveText(
    en["workbench.at.state.uncertain"],
  );
  await expect(row("OK")).toContainText(en["workbench.at.kind.payload"]);

  await command.fill("AT");
  await sample.fill("2\n0");
  await dialog
    .getByRole("combobox", { name: en["workbench.at.format"] })
    .click();
  await page.getByRole("option", { name: en["workbench.at.numeric"] }).click();
  await parse.click();
  await expect(report.getByRole("status")).toHaveText(
    en["workbench.at.state.complete"],
  );
  await expect(row("RING")).toContainText(en["workbench.at.kind.urc"]);
  await expect(row("OK")).toContainText(en["workbench.at.kind.result"]);
});

test("the workbench scans only visible receive data through the Host action and result file", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 600 });
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-framing/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid framing catalog fixture");
  const action = manifest.contributes.parsers[0];
  if (!action) throw new Error("Missing framing catalog fixture");
  const reference = {
    hostId: "workbench-gui-host",
    kind: "plugin_result",
    id: "framed-fixture",
    revision: "1",
  };
  const encoded = Buffer.from(
    JSON.stringify({
      frames: [
        {
          bytesBase64: "QQo=",
          source: {
            hostId: reference.hostId,
            sessionId: "session",
            sessionEpoch: "1",
            direction: "rx",
            eventStart: "4",
            eventEnd: "6",
            byteStart: "7",
            byteEnd: "9",
          },
        },
      ],
      incompleteBytes: 0,
    }),
  );
  await seedWorkbenchFixture(page, {
    language: "en",
    extraActions: [xyCaptureFixture().action],
    framing: {
      action,
      page: {
        fileRef: reference,
        offset: "0",
        nextOffset: String(encoded.length),
        totalBytes: String(encoded.length),
        bytesBase64: encoded.toString("base64"),
        fingerprint: createHash("sha256").update(encoded).digest("hex"),
        atEnd: true,
      },
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const sample = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (sample?.kind !== "source") throw new Error("Missing Raw RX fixture");
  const visible = (eventSeq: string, byteStart: string, content: string) => ({
    kind: "source",
    event: {
      ...sample.event,
      kind: "rx",
      eventSeq,
      payload: {
        bytesBase64: Buffer.from(content).toString("base64"),
        byteStart,
        byteEnd: String(Number(byteStart) + content.length),
      },
    },
  });
  await page.evaluate(
    (item) => window.workbenchFixture.emitRaw([item]),
    visible("3", "0", "CLEARED"),
  );
  const log = page.getByRole("log");
  await expect(log).toContainText("CLEARED");
  await page
    .getByRole("button", { name: en["workbench.tools.clearView"], exact: true })
    .click();
  await expect(log).not.toContainText("CLEARED");
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    [visible("4", "7", "A"), visible("5", "8", "\n")],
  );
  await expect(log.getByText("A", { exact: true })).toBeVisible();
  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await receive.getByRole("radio", { name: "HEX", exact: true }).click();
  const merged = log.locator('[data-hex-byte-start="7"]');
  await expect(merged).toHaveText("41 0A");
  await expect(merged).toHaveAttribute("data-hex-source", /,"5"\]$/);
  await merged.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Receive HEX bytes are missing");
    document.getSelection()?.setBaseAndExtent(text, 0, text, 2);
  });
  await receive
    .getByRole("button", { name: "Plot selected receive bytes" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await expect(dialog.getByLabel(en["workbench.framing.start"])).toHaveValue(
    "4",
  );
  await expect(dialog.getByLabel(en["workbench.framing.end"])).toHaveValue("6");
  await dialog
    .getByRole("combobox", { name: en["workbench.framing.mode"] })
    .click();
  await page
    .getByRole("option", {
      name: en["workbench.framing.delimiter"],
      exact: true,
    })
    .click();
  await dialog.getByLabel(en["workbench.framing.delimiterHex"]).fill("0A");
  await dialog
    .getByRole("button", { name: en["workbench.framing.scan"] })
    .click();

  const frames = dialog.getByRole("region", {
    name: en["workbench.framing.results"],
  });
  await expect(frames.getByText("41 0A", { exact: true })).toBeVisible();
  await expect(
    dialog
      .getByRole("region", { name: en["workbench.framing.results"] })
      .getByText(/Bytes 7 to 9/),
  ).toBeVisible();
  const definition = dialog.getByLabel(en["workbench.fields.definition"]);
  await dialog
    .getByRole("button", { name: en["workbench.fields.example"] })
    .click();
  await dialog
    .getByRole("button", { name: en["workbench.fields.decode"] })
    .click();
  await expect(
    dialog.getByRole("row").filter({ hasText: "payload" }),
  ).toContainText("Bytes [7, 9)");
  await definition.fill(
    JSON.stringify({
      version: "1",
      byteLength: 2,
      fields: [
        {
          id: "reading",
          kind: "integer",
          byteOffset: 0,
          width: 1,
          order: "big",
          scale: "0.5",
          bias: "1",
          labels: { "65": "Ping" },
          unit: "mV",
        },
      ],
    }),
  );
  await dialog
    .getByRole("button", { name: en["workbench.fields.decode"] })
    .click();
  const reading = dialog.getByRole("row").filter({ hasText: "reading" });
  await expect(reading).toContainText("33.5 mV");
  await expect(reading).toContainText("Ping");
  await expect(reading).toContainText("Bytes [7, 8)");
  await expect(reading.getByText("41", { exact: true })).toBeVisible();

  const byteMap = dialog.getByRole("region", {
    name: en["workbench.fields.byteMap"],
  });
  const rawBytes = byteMap.getByRole("region", {
    name: en["workbench.fields.source"],
  });
  const field = byteMap.getByRole("button", { name: "reading", exact: true });
  await field.focus();
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-pressed", "true");
  await expect(byteMap.getByText("33.5 mV · Ping")).toBeVisible();
  await expect(byteMap.getByText("Bytes [7, 8)")).toBeVisible();
  await byteMap
    .getByRole("combobox", { name: en["workbench.fields.byteRole"] })
    .click();
  await page.getByRole("option", { name: "Address", exact: true }).click();
  await expect(field).toHaveAttribute("data-field-role", "address");
  await expect(
    rawBytes.getByRole("button", { name: "Inspect reading bytes" }),
  ).toHaveAttribute("data-field-role", "address");
  await expect(rawBytes.locator("[data-unclassified-bytes]")).toHaveText("0A");
  await byteMap.screenshot({
    path: testInfo.outputPath("protocol-byte-map.png"),
  });

  await dialog.getByText("Field chart", { exact: true }).click();
  const chart = dialog.getByRole("region", { name: "Field chart" });
  await chart.getByRole("button", { name: "Plot fields" }).click();
  await chart.getByRole("slider", { name: "Frame cursor" }).focus();
  await chart.getByRole("slider", { name: "Frame cursor" }).press("Enter");
  await expect(chart.getByRole("status")).toContainText("33.5 mV");
  await expect(chart.getByRole("listitem")).toContainText(
    "Event 4 · Bytes [7, 8)",
  );
  await expect(chart.getByRole("listitem").getByText("41")).toBeVisible();
  await dialog.getByText("Bus load", { exact: true }).click();
  const bus = dialog.getByRole("region", { name: "Bus load" });
  await expect(bus.getByText(/Clock fixture-clock/)).toBeVisible();
  await expect(bus.getByText("2 B observed")).toBeVisible();
  await expect(bus.getByText("Partial", { exact: true })).toBeVisible();
  await expect(
    bus.getByRole("columnheader", { name: "Protocol errors" }),
  ).toBeVisible();
  await dialog.getByText("Bus load", { exact: true }).click();
  const capture = chart.getByRole("region", { name: "Cross-source XY" });
  await capture.getByRole("button", { name: "Stage as X" }).click();
  await expect(capture.getByText("X · reading · 1 samples")).toBeVisible();
  await expect(
    capture.getByRole("button", { name: "Open cross-source XY" }),
  ).toHaveCount(0);
  await capture.getByRole("button", { name: "Clear staged samples" }).click();
  await expect(reading).toHaveAttribute("data-chart-selected", "true");
  await dialog
    .getByRole("button", { name: en["workbench.fields.edit"] })
    .click();
  const value = dialog.getByRole("textbox", {
    name: "reading (mV)",
    exact: true,
  });
  await expect(value).toHaveValue("33.5");
  await value.fill("34");
  await dialog
    .getByRole("button", { name: en["workbench.fields.generate"] })
    .click();
  await expect(
    dialog.getByLabel(en["workbench.fields.generated"], { exact: true }),
  ).toHaveText("42 0A");
  await expect(reading).toContainText("34 mV");
  await expect(reading).toContainText("Bytes [0, 1)");
  await definition.fill(
    JSON.stringify({ version: "2", byteLength: 2, fields: [] }),
  );
  await dialog
    .getByRole("button", { name: en["workbench.fields.decode"] })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("version");
  await expect(reading).toHaveCount(0);
  await expect(rawBytes.locator("[data-unclassified-bytes]")).toHaveText(
    "41 0A",
  );
  await expect(rawBytes.getByRole("button")).toHaveCount(0);
  const checked = await page.evaluate((id) => {
    const fixture = window.workbenchFixture;
    return {
      call: fixture.invocations.find((item) => item.actionId === id),
      query: fixture.queryInputs.find(
        (item) =>
          item.actionId === "action.check" && item.params.actionId === id,
      ),
      observed: fixture.hostQueries.includes("operation.get"),
      read: fixture.hostQueries.includes("file.read"),
    };
  }, action.actionId);
  expect(checked.call?.params).toEqual({
    startEventSeq: "4",
    endEventSeq: "6",
    maxFrameLength: 4096,
    delimiterBase64: "Cg==",
  });
  expect(checked.query?.target).toEqual(checked.call?.target);
  expect(checked.observed).toBe(true);
  expect(checked.read).toBe(true);

  await definition.fill(
    JSON.stringify({
      version: "1",
      byteLength: 2,
      fields: [
        {
          id: "reading",
          kind: "integer",
          byteOffset: 0,
          width: 1,
          order: "big",
        },
        {
          id: "crc",
          kind: "checksum",
          algorithm: "sum",
          order: "big",
          byteOffset: 1,
          coverageStart: 0,
          coverageEnd: 1,
        },
      ],
    }),
  );
  const anomalies = dialog.getByText(en["workbench.anomalies.title"], {
    exact: true,
  });
  await anomalies.click();
  const review = anomalies.locator("..");
  await review
    .getByRole("button", { name: en["workbench.anomalies.inspect"] })
    .click();
  await expect(review.getByRole("status")).toHaveText(
    "1 frames checked · 1 findings",
  );
  await expect(review.getByRole("listitem")).toContainText(
    "Checksum crc · received 0A · expected 41",
  );
  await expect(review.getByRole("listitem")).toContainText("Bytes 7 to 9");
  await chart.getByRole("button", { name: "Plot fields" }).click();
  await chart.getByText("Statistics", { exact: true }).click();
  await expect(chart.getByText("1 / 1 (100%)", { exact: true })).toBeVisible();
  await expect(
    chart.getByRole("definition").filter({ hasText: "—" }),
  ).toHaveCount(7);
  await definition.fill(
    JSON.stringify({
      version: "1",
      byteLength: 2,
      fields: [
        {
          id: "reading",
          kind: "integer",
          byteOffset: 0,
          width: 1,
          order: "big",
        },
      ],
    }),
  );
  await chart.getByRole("button", { name: "Plot fields" }).click();
  await chart
    .getByRole("button", { name: "Show bytes in receive view" })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(definition).toHaveValue(/"id":"reading"/);
  await chart
    .getByRole("button", { name: "Show bytes in receive view" })
    .click();
  await page
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(receive.getByLabel("Selected source bytes")).toContainText("41");
  await expect(receive.getByLabel("Selected source bytes")).toContainText(
    "[7, 8)",
  );
  await expect(log.locator('[data-location-target="true"]')).toContainText(
    "41 0A",
  );
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString()))
    .toBe("41");
});

test("bus load marks earlier windows as uncovered after moving to the next frame page", async ({
  page,
}) => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-framing/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid framing catalog fixture");
  const action = manifest.contributes.parsers[0];
  if (!action) throw new Error("Missing framing catalog fixture");
  const prototype = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (prototype?.kind !== "source") throw new Error("Missing Raw RX fixture");
  const reference = {
    hostId: prototype.event.hostId,
    kind: "plugin_result",
    id: "paged-framing-fixture",
    revision: "1",
  };
  const { sessionId, sessionEpoch } = prototype.event;
  function file(body: unknown) {
    const data = Buffer.from(JSON.stringify(body));
    return {
      fileRef: reference,
      offset: "0",
      nextOffset: String(data.length),
      totalBytes: String(data.length),
      bytesBase64: data.toString("base64"),
      fingerprint: createHash("sha256").update(data).digest("hex"),
      atEnd: true,
    };
  }
  const blocks = [
    { seq: 3, ms: 0, start: 0, data: "A".repeat(127) },
    { seq: 4, ms: 100, start: 127, data: "BCD" },
    { seq: 5, ms: 250, start: 130, data: "E" },
    { seq: 6, ms: 300, start: 131, data: "F" },
  ];
  const frames = blocks.flatMap(({ seq, start, data }) =>
    Array.from(data, (character, offset) => ({
      bytesBase64: Buffer.from(character).toString("base64"),
      source: {
        hostId: reference.hostId,
        sessionId,
        sessionEpoch,
        direction: "rx",
        byteStart: String(start + offset),
        byteEnd: String(start + offset + 1),
        eventStart: String(seq),
        eventEnd: String(seq + 1),
      },
    })),
  );
  await seedWorkbenchFixture(page, {
    language: "en",
    framing: {
      action,
      page: file({
        frames: frames.slice(0, 128),
        incompleteBytes: 0,
        nextCursor: { eventSeq: "4", byteStart: "128" },
      }),
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const events = blocks.map(({ seq, ms, start, data }) => ({
    kind: "source" as const,
    event: {
      ...prototype.event,
      kind: "rx" as const,
      eventSeq: String(seq),
      time: {
        ...prototype.event.time,
        sourceMonoNs: String(1000000 + ms * 1000000),
      },
      payload: {
        bytesBase64: Buffer.from(data).toString("base64"),
        byteStart: String(start),
        byteEnd: String(start + data.length),
      },
    },
  }));
  await page.evaluate(
    (items) => window.workbenchFixture.emitRaw(items),
    events,
  );
  await expect(page.getByRole("log")).toContainText("BCD");
  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await dialog
    .getByRole("combobox", { name: en["workbench.framing.mode"] })
    .click();
  await page
    .getByRole("option", { name: en["workbench.framing.fixed"], exact: true })
    .click();
  await dialog
    .getByLabel(en["workbench.framing.fixedLength"], { exact: true })
    .fill("1");
  await dialog
    .getByRole("button", { name: en["workbench.framing.scan"] })
    .click();
  const next = dialog.getByRole("button", {
    name: en["workbench.framing.next"],
  });
  await expect(next).toBeVisible();
  await dialog.getByText("Bus load", { exact: true }).click();
  const bus = dialog.getByRole("region", { name: "Bus load" });
  const row = (range: string) =>
    bus.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: range, exact: true }),
    });
  await expect(row("0–100").getByRole("cell").nth(3)).toHaveText("1,270");
  await page.evaluate(
    (data) => window.workbenchFixture.setFramingResult(data),
    file({ frames: frames.slice(128), incompleteBytes: 0 }),
  );
  await next.click();
  await expect(next).toHaveCount(0);
  await expect(row("0–100").getByRole("cell").nth(0)).toHaveText("1,270");
  await expect(row("0–100").getByRole("cell").nth(3)).toHaveText("—");
  await expect(row("100–200").getByRole("cell").nth(3)).toHaveText("—");
  await expect(row("0–100")).toContainText(
    "Raw complete · partial frame coverage",
  );
  await expect(row("200–300").getByRole("cell").nth(3)).toHaveText("10");
});
