import { expect, test } from "@playwright/test";
import type { RpcRequest } from "@serial-workbench/contracts";
import { session } from "../../src/features/workbench/test-fixtures";
import type { GlobalSendEvent } from "../../src/lib/generated/bindings";
import { seedWorkbenchFixture } from "./workbench.fixture";

declare global {
  interface Window {
    globalSendProbe: {
      enabled: boolean;
      revision: number;
      allowed: boolean;
      publishedTargets: number;
      settingsUnavailable: boolean;
      settingsOpened: number;
      press(revision: number): void;
      changeSystemBinding(trigger: string | null): void;
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
    replay: {
      session: {
        ...session("global-send-replay"),
        deviceId: "explicit-replay-layout",
        readOnly: true,
      },
      files: {},
      page: {
        records: [],
        readerGeneration: "1",
        nextRecord: "0",
        atEnd: true,
      },
    },
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
      settingsUnavailable: false,
      settingsOpened: 0,
      press: (_revision: number) => {},
      changeSystemBinding: (_trigger: string | null) => {},
    };
    window.globalSendProbe = probe;
    let activeRegistration: unknown;
    native.invoke = async (command, args = {}) => {
      if (command === "configure_global_send") {
        const binding = args.binding as { key: string } | null;
        if (binding?.key === "F10")
          throw { code: "CONFLICT", message: "Occupied", retryable: false };
        activeRegistration = binding ? args.registration : undefined;
        const channel = args.events as {
          onmessage: (value: GlobalSendEvent) => void;
        };
        probe.press = (revision) =>
          channel.onmessage({ kind: "press", revision });
        probe.changeSystemBinding = (trigger) =>
          channel.onmessage({ kind: "binding", trigger });
        probe.enabled = false;
        const key = binding?.key;
        return {
          trigger: key === "F8" || key === "F7" ? `Alt+${key}` : null,
          canConfigure: key === "F8",
        };
      }
      if (command === "open_global_send_settings") {
        if (
          probe.settingsUnavailable ||
          args.registration !== activeRegistration
        )
          throw {
            code: "WINDOW_ERROR",
            message: "Settings unavailable",
            retryable: false,
          };
        probe.settingsOpened++;
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

  await page.evaluate(() => {
    window.location.hash = "#/settings";
  });
  await expect(page.locator("#settings-language")).toBeVisible();
  await expect.poll(enabled).toBe(false);
  await press(firstTarget);
  await press(await revision());
  expect(await writes()).toEqual(["QVQ="]);
  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  await expect(draft).toHaveValue("AT");
  await expect.poll(enabled).toBe(true);
  await expect.poll(revision).toBeGreaterThan(firstTarget);

  const beforeEmptyDraft = await revision();
  await draft.clear();
  await expect.poll(enabled).toBe(false);
  await press(beforeEmptyDraft);
  await press(await revision());
  expect(await writes()).toEqual(["QVQ="]);
  await draft.fill("AT");
  await expect.poll(enabled).toBe(true);

  const beforeReplay = await revision();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("dialog", { name: "Activity", exact: true });
  await activity
    .getByRole("button", {
      name: "Locate fixture-attached-replay",
      exact: true,
    })
    .click();
  await expect(activity).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Replay", exact: true }),
  ).toBeVisible();
  await draft.fill("READ ONLY REPLAY");
  await expect.poll(enabled).toBe(false);
  await press(beforeReplay);
  await press(await revision());
  expect(await writes()).toEqual(["QVQ="]);
  await page.getByRole("tab", { name: "Virtual serial", exact: true }).click();
  await expect(draft).toHaveValue("AT");
  await expect.poll(enabled).toBe(true);

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

  await change.click();
  await capture.press("Control+Shift+F8");
  await save.click();
  await expect(row.getByText("Alt+F8", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1240, height: 680 });
  await change.click();
  await expect(capture).toBeFocused();
  await expect(capture).toHaveValue("Alt+F8");
  await capture.press("Control+Shift+F7");
  await expect(capture).toHaveValue("Alt+F8");
  await expect(save).toHaveCount(0);
  const openSettings = dialog.getByRole("button", {
    name: "Open system shortcut settings",
  });
  await page.evaluate(() => {
    window.globalSendProbe.settingsUnavailable = true;
  });
  await openSettings.click();
  await expect(dialog.getByRole("status")).toHaveText(
    "The shortcut settings could not be opened. Try again.",
  );
  await expect(capture).toBeFocused();
  await expect(capture).toHaveValue("Alt+F8");
  await page.evaluate(() => {
    window.globalSendProbe.settingsUnavailable = false;
  });
  await openSettings.click();
  await expect(change).toBeFocused();
  expect(await page.evaluate(() => window.globalSendProbe.settingsOpened)).toBe(
    1,
  );
  await expect(row.getByText("Alt+F8", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.globalSendProbe.allowed = true;
  });
  await draft.fill("NEW");
  await expect.poll(enabled).toBe(true);
  const beforeSystemChange = await revision();
  await page.evaluate(() =>
    window.globalSendProbe.changeSystemBinding("Ctrl+Alt+F8"),
  );
  await expect.poll(revision).toBeGreaterThan(beforeSystemChange);
  await press(beforeSystemChange);
  expect(await writes()).toEqual(["QVQ=", "T0s="]);
  await press(await revision());
  await expect.poll(writes).toEqual(["QVQ=", "T0s=", "TkVX"]);
  await page.keyboard.press("F1");
  await dialog.getByRole("searchbox").fill("global send");
  await expect(row.getByText("Ctrl+Alt+F8", { exact: true })).toBeVisible();
  await page.evaluate(() => window.globalSendProbe.changeSystemBinding(null));
  await expect(row.getByText("Off", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(enabled).toBe(false);
  const unboundRevision = await revision();
  await press(unboundRevision);
  expect(await writes()).toEqual(["QVQ=", "T0s=", "TkVX"]);

  await page.evaluate(() =>
    window.globalSendProbe.changeSystemBinding("Ctrl+Alt+F9"),
  );
  await expect.poll(enabled).toBe(true);
  await expect.poll(revision).toBeGreaterThan(unboundRevision);
  await press(unboundRevision);
  expect(await writes()).toEqual(["QVQ=", "T0s=", "TkVX"]);
  await press(await revision());
  await expect.poll(writes).toEqual(["QVQ=", "T0s=", "TkVX", "TkVX"]);

  await page.keyboard.press("F1");
  await dialog.getByRole("searchbox").fill("global send");
  await expect(row.getByText("Ctrl+Alt+F9", { exact: true })).toBeVisible();
  await page.evaluate(() => window.globalSendProbe.changeSystemBinding(null));
  await expect(row.getByText("Off", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 420, height: 620 });
  await change.click();
  await capture.press("Control+Shift+F7");
  await save.click();
  await expect(row.getByText("Alt+F7", { exact: true })).toBeVisible();
  await change.click();
  await expect(capture).toBeFocused();
  await expect(capture).toHaveAccessibleDescription(
    "Change this shortcut in your desktop’s shortcut settings.",
  );
  await expect(openSettings).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Disable" }),
  ).toBeInViewport();
  await dialog.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Off", { exact: true })).toBeVisible();

  await change.click();
  await capture.press("Control+Shift+F9");
  await save.click();
  await expect(row.getByText("Ctrl+Shift+F9", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(enabled).toBe(true);

  const beforePreprocess = await revision();
  await page.getByRole("button", { name: "Send preprocessing" }).click();
  const preprocess = page.getByRole("dialog", { name: "Send preprocessing" });
  await preprocess
    .getByRole("switch", { name: "Enable preprocessing" })
    .click();
  await expect.poll(enabled).toBe(false);
  await press(beforePreprocess);
  expect(await writes()).toEqual(["QVQ=", "T0s=", "TkVX", "TkVX"]);
  await preprocess.getByRole("button", { name: "Load JSON example" }).click();
  await preprocess.getByRole("button", { name: "Generate preview" }).click();
  await expect(
    preprocess.getByRole("region", { name: /Final HEX/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(enabled).toBe(true);
  await press(await revision());
  const finalWrites = [
    "QVQ=",
    "T0s=",
    "TkVX",
    "TkVX",
    Buffer.from('{"data":"NEW"}').toString("base64"),
  ];
  await expect.poll(writes).toEqual(finalWrites);

  const connectedRevision = await revision();
  expect(
    await page.evaluate(() => window.workbenchFixture.failHost()),
  ).toBeGreaterThan(0);
  await expect.poll(enabled).toBe(false);
  await expect.poll(revision).toBeGreaterThan(connectedRevision);
  await press(connectedRevision);
  await press(await revision());
  expect(await writes()).toEqual(finalWrites);
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
