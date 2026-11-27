import { expect, test } from "@playwright/test";
import { operation, session } from "../../src/features/workbench/test-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("previews recorded TX before allowing confirmed transmission to the chosen session", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 660 });
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  await expect(page.locator(".workbench")).toBeVisible();
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    ({ revision, configurationJson, operationJson }) => {
      const native: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
      const object = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null;
      if (!object(native) || typeof native.invoke !== "function")
        throw new Error("Missing native workbench bridge");
      const invoke = native.invoke;
      const open: unknown = JSON.parse(operationJson);
      const configuration: unknown = JSON.parse(configurationJson);
      if (!object(open) || !object(configuration))
        throw new Error("Missing replay transmission fixture");
      const fixture = {
        previews: [] as unknown[],
        transmissions: [] as unknown[],
        allowed: true,
        readAllowed: true,
      };
      Reflect.set(window, "transmitReplayFixture", fixture);
      const source = {
        hostId: "workbench-gui-host",
        kind: "file",
        id: "recorded-source",
        revision: "1",
      };
      const digest = "a".repeat(64);
      Reflect.set(
        native,
        "invoke",
        async (command: string, args: Record<string, unknown> = {}) => {
          if (
            command === "choose_file_resource" &&
            args.role === "capturePeerSource"
          )
            return {
              reference: source,
              name: "controller.swbc",
              length: "1024",
              mime: "application/octet-stream",
            };
          const rpc = args.request;
          if (command === "host_request" && object(rpc) && object(rpc.params)) {
            const call = rpc.params;
            const target = call.target;
            const params = call.params;
            if (rpc.method === "action.query" && object(target)) {
              if (
                call.actionId === "replay.transmit.preview" &&
                object(params)
              ) {
                fixture.previews.push({ target, params });
                return {
                  ok: true,
                  result: {
                    kind: "replay_transmit_preview",
                    value: {
                      captureRef: source,
                      target,
                      targetRevision: revision,
                      configuration,
                      direction: "tx",
                      bytesPerSecond: params.bytesPerSecond,
                      bytesBase64: "AQID",
                      spans: [
                        {
                          recordOrdinal: "4",
                          outputOffset: "0",
                          source: {
                            hostId: "recording-host",
                            sessionId: "recorded-session",
                            sessionEpoch: "1",
                            eventStart: "2",
                            eventEnd: "3",
                            byteStart: "0",
                            byteEnd: "3",
                            direction: "tx",
                          },
                        },
                      ],
                      previewDigest: digest,
                    },
                  },
                };
              }
              if (
                call.actionId === "action.check" &&
                object(params) &&
                (params.actionId === "replay.transmit" ||
                  params.actionId === "replay.transmit.preview")
              )
                return {
                  ok: true,
                  result: {
                    kind: "action_check",
                    value: {
                      actionId: params.actionId,
                      target,
                      allowed:
                        params.actionId === "replay.transmit"
                          ? fixture.allowed
                          : fixture.readAllowed,
                    },
                  },
                };
            }
            if (
              rpc.method === "action.invoke" &&
              call.actionId === "replay.transmit" &&
              object(target)
            ) {
              fixture.transmissions.push({
                target,
                params,
                revision: call.expectedRevision,
                mode: call.executionMode,
              });
              const operationId = crypto.randomUUID();
              return {
                ok: true,
                result: {
                  operation: {
                    ...open,
                    operationId,
                    rootOperationId: operationId,
                    requestId: call.requestId,
                    actorId: call.actorId,
                    executionHostId: call.hostId,
                    actionId: "replay.transmit",
                    target,
                    executionMode: "independent",
                    owner: { kind: "host", id: call.hostId },
                    state: "succeeded",
                    revealTarget: { pageId: "workbench", sessionId: target.id },
                    result: {
                      kind: "file_transfer",
                      value: {
                        requested: "3",
                        accepted: "3",
                        unknown: "0",
                        peerAcknowledged: false,
                        receiptsRef: {
                          hostId: call.hostId,
                          kind: "transfer_receipts",
                          id: operationId,
                          revision: "1",
                        },
                      },
                    },
                  },
                },
              };
            }
          }
          return Reflect.apply(invoke, native, [command, args]);
        },
      );
    },
    {
      revision: session().revision,
      configurationJson: JSON.stringify(session().configuration),
      operationJson: JSON.stringify(operation(crypto.randomUUID())),
    },
  );

  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Open replay", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Simulate recorded peer", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Transmit recorded TX" }).click();
  const tool = page.getByRole("dialog", { name: "Transmit recorded TX" });
  const send = tool.getByRole("button", { name: "Confirm and transmit" });
  const preview = tool.getByRole("button", { name: "Generate preview" });
  await expect(send).toBeDisabled();
  await tool.getByRole("button", { name: "Choose recording" }).click();
  await tool.getByRole("combobox", { name: "Writable session" }).click();
  await page.getByRole("option").filter({ hasText: "115200" }).first().click();
  await preview.click();
  const bytes = tool.getByRole("region", { name: "Final bytes" });
  await expect(bytes.getByText("01 02 03", { exact: true })).toBeVisible();
  await expect(bytes.getByText("TX · 3 bytes at 1024 B/s")).toBeVisible();
  await expect(send).toBeEnabled();

  await tool.getByRole("textbox", { name: "Speed (bytes/s)" }).fill("2048");
  await expect(bytes).toBeHidden();
  await expect(send).toBeDisabled();
  await preview.click();
  await expect(bytes.getByText("TX · 3 bytes at 2048 B/s")).toBeVisible();
  const invocations = () =>
    page.evaluate(() =>
      Reflect.get(
        Reflect.get(window, "transmitReplayFixture"),
        "transmissions",
      ),
    );
  expect(await invocations()).toEqual([]);
  await page.screenshot({
    path: info.outputPath("replay-transmit-narrow.png"),
  });
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.screenshot({ path: info.outputPath("replay-transmit-wide.png") });

  await page.evaluate(() =>
    Reflect.set(Reflect.get(window, "transmitReplayFixture"), "allowed", false),
  );
  await expect(send).toBeDisabled();
  expect(await invocations()).toEqual([]);
  await page.evaluate(() =>
    Reflect.set(Reflect.get(window, "transmitReplayFixture"), "allowed", true),
  );
  await expect(send).toBeEnabled();
  await page.evaluate(() =>
    Reflect.set(
      Reflect.get(window, "transmitReplayFixture"),
      "readAllowed",
      false,
    ),
  );
  await expect(bytes).toBeHidden();
  await expect(send).toBeDisabled();
  await page.evaluate(() =>
    Reflect.set(
      Reflect.get(window, "transmitReplayFixture"),
      "readAllowed",
      true,
    ),
  );
  await expect(send).toBeDisabled();
  await preview.click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(tool.getByRole("status")).toContainText("Accepted 3 of 3 bytes");

  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
  });
  await page.keyboard.press("Escape");
  await expect(tool).toBeHidden();
  await menu.click();
  await page.getByRole("menuitem", { name: "Tasks", exact: true }).click();
  const tasks = page.getByRole("dialog", { name: "Tasks", exact: true });
  await expect(
    tasks.getByText("Transmit recorded TX", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tasks).toBeHidden();
  await menu.click();
  await page.getByRole("menuitem", { name: "Transmit recorded TX" }).click();
  await expect(tool.getByRole("status")).toContainText("Accepted 3 of 3 bytes");

  expect(await invocations()).toEqual([
    {
      target: {
        hostId: "workbench-gui-host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      },
      params: {
        selection: {
          captureRef: {
            hostId: "workbench-gui-host",
            kind: "file",
            id: "recorded-source",
            revision: "1",
          },
          direction: "tx",
          bytesPerSecond: "2048",
        },
        previewDigest: "a".repeat(64),
      },
      revision: "1",
      mode: "independent",
    },
  ]);
});
