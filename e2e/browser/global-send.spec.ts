import { expect, test } from "@playwright/test";
import type { RpcRequest } from "@serial-workbench/contracts";
import { session } from "../../src/features/workbench/test-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

declare global {
  interface Window {
    globalSendProbe: {
      enabled: boolean;
      revision: number;
      allowed: boolean;
      publishedTargets: number;
      press(revision: number): void;
    };
  }
}

test("desktop global send keeps the registered key on conflict and follows authorized live targets", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 680 });
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    manualSendReceipts: true,
    secondDevice: {
      deviceId: "peer-device",
      hostId: "workbench-gui-host",
      systemName: "Peer serial",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities: session().capabilities,
    },
  });
  await page.goto("./#/");
  await page.evaluate(() => {
    const native = Reflect.get(window, "__TAURI_INTERNALS__") as {
      invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    };
    const invoke = native.invoke.bind(native);
    const probe = {
      enabled: false,
      revision: 0,
      allowed: true,
      publishedTargets: 0,
      press: (_revision: number) => {},
    };
    window.globalSendProbe = probe;
    native.invoke = async (command, args = {}) => {
      if (command === "configure_global_send") {
        const binding = args.binding as { key: string } | null;
        if (binding?.key === "F10")
          throw { code: "CONFLICT", message: "Occupied", retryable: false };
        probe.press = binding
          ? (args.onPress as { onmessage: (value: number) => void }).onmessage
          : () => {};
        probe.enabled = false;
        return null;
      }
      if (command === "set_global_send_target") {
        probe.revision = Number(args.revision);
        probe.enabled = args.enabled === true;
        if (probe.enabled) probe.publishedTargets++;
        return null;
      }
      const request = args.request as RpcRequest | undefined;
      const response = await invoke(command, args);
      if (
        !probe.allowed &&
        request?.method === "action.query" &&
        request.params.actionId === "action.check" &&
        Reflect.get(request.params.params, "actionId") === "session.tx"
      ) {
        return {
          ok: true,
          result: {
            kind: "action_check",
            value: {
              actionId: "session.tx",
              target: request.params.target,
              allowed: false,
            },
          },
        };
      }
      return response;
    };
  });
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  const draft = page.getByRole("textbox", { name: "Send draft" });
  await draft.fill("AT");
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await dialog.getByRole("searchbox").fill("global send");
  const row = dialog
    .getByRole("listitem")
    .filter({ hasText: "Global send shortcut" });
  const change = row.getByRole("button", { name: /Change shortcut/ });
  const capture = dialog.getByRole("textbox", { name: /Change shortcut/ });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(row.getByText("Off", { exact: true })).toBeVisible();
  await change.click();
  await expect(capture).toBeFocused();
  await capture.press("Control+Enter");
  await expect(dialog.getByRole("status")).toContainText("Already used by");
  await expect(save).toBeDisabled();
  await capture.press("Control+Shift+F9");
  await save.click();
  await expect(change).toBeFocused();
  await expect(row.getByText("Ctrl+Shift+F9", { exact: true })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("global-send-wide.png") });
  await page.setViewportSize({ width: 420, height: 620 });
  await change.click();
  await capture.press("Control+Shift+F10");
  await save.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Try another combination",
  );
  await expect(capture).toHaveValue("Ctrl+Shift+F10");
  await expect(row.getByText("Ctrl+Shift+F9", { exact: true })).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("global-send-narrow-conflict.png"),
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(change).toBeFocused();
  await page.keyboard.press("Escape");

  const enabled = () => page.evaluate(() => window.globalSendProbe.enabled);
  const revision = () => page.evaluate(() => window.globalSendProbe.revision);
  const press = (value: number) =>
    page.evaluate((value) => window.globalSendProbe.press(value), value);
  const writes = () => page.evaluate(() => window.workbenchFixture.sentBytes);
  await expect.poll(enabled).toBe(true);
  const firstTarget = await revision();
  await press(firstTarget);
  await expect.poll(writes).toEqual(["QVQ="]);

  await page
    .getByRole("combobox", { name: "Choose device", exact: true })
    .click();
  await page.getByRole("option", { name: "Peer serial" }).click();
  await page
    .getByRole("button", { name: "Open Peer serial", exact: true })
    .click();
  await draft.fill("OK");
  await expect.poll(enabled).toBe(true);
  await press(firstTarget);
  await press(await revision());
  await expect.poll(writes).toEqual(["QVQ=", "T0s="]);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.invocations
        .filter(({ actionId }) => actionId === "session.tx")
        .map(({ target, expectedRevision }) => [
          target.sessionId,
          expectedRevision,
        ]),
    ),
  ).toEqual([
    ["session", expect.any(String)],
    ["second-session", expect.any(String)],
  ]);

  const authorizedTarget = await revision();
  const publishedTargets = () =>
    page.evaluate(() => window.globalSendProbe.publishedTargets);
  const countBeforeEdit = await publishedTargets();
  await page.evaluate(() => {
    window.globalSendProbe.allowed = false;
  });
  await draft.fill("blocked");
  await expect.poll(enabled).toBe(false);
  const send = page.getByRole("region", { name: "Send", exact: true });
  await expect(
    send.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  expect(await publishedTargets()).toBe(countBeforeEdit);
  await press(authorizedTarget);
  await press(await revision());
  expect(await writes()).toEqual(["QVQ=", "T0s="]);

  await page.keyboard.press("F1");
  await dialog.getByRole("searchbox").fill("global send");
  await change.click();
  await dialog.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Off", { exact: true })).toBeVisible();
});

test("browser shortcuts do not expose system registration", async ({
  page,
}) => {
  await page.goto("./#/settings");
  await page
    .locator(".app-title-bar")
    .getByRole("button", { name: "快速操作", exact: true })
    .focus();
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", { name: "快捷键速查" });
  await expect(dialog.getByText("发送草稿")).toBeVisible();
  await expect(dialog.getByText("全局发送热键")).toHaveCount(0);
});
