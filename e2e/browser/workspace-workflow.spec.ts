/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import { seedWorkbenchFixture } from "./workbench.fixture";
import type {
  DeviceDescriptor,
  DeviceFingerprint,
  SessionSnapshot,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import { session } from "../../src/features/workbench/test-fixtures";

declare global {
  interface Window {
    workspaceWorkflowGate?: {
      defaultReadStarted: boolean;
      releaseDefault: () => void;
      events: string[];
    };
  }
}

async function evidence(page: Page, info: TestInfo, stage: string) {
  await page.screenshot({ path: info.outputPath(`${stage}.png`) });
  await writeFile(
    info.outputPath(`${stage}.txt`),
    await page.locator("body").ariaSnapshot(),
  );
}

async function openWorkspace(page: Page) {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Workspace", exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

function preset(name: string): WorkspaceDocument {
  return {
    ...defaults.workspace,
    name,
    bindings: [
      {
        bindingId: "shared-binding",
        hostId: "workbench-gui-host",
        deviceId: "device",
        fingerprint: { transport: "virtual", evidence: "unreliable" },
        configuration: session().configuration,
        reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
      },
    ],
    views: [
      {
        id: "shared-view",
        bindingId: "shared-binding",
        name: "Controller",
        color: "#2266AA",
        icon: "terminal",
        pinned: false,
        receiveMode: "text",
        sendMode: "text",
      },
    ],
  };
}

async function provideDeviceCatalog(
  page: Page,
  devices: readonly DeviceDescriptor[],
  connectedSession?: SessionSnapshot,
) {
  // 延后首次附着，只替换 Native 设备目录，不触及生产选择或视图状态。
  await page.evaluate((raw: string) => {
    const fixture: unknown = JSON.parse(raw);
    if (typeof fixture !== "object" || fixture === null)
      throw new Error("Invalid device fixture payload");
    const devices: unknown = Reflect.get(fixture, "devices");
    if (!Array.isArray(devices)) throw new Error("Missing fixture devices");
    const connectedSession: unknown = Reflect.get(fixture, "connectedSession");
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (typeof internals !== "object" || internals === null)
      throw new Error("Missing Native fixture");
    const invoke: unknown = Reflect.get(internals, "invoke");
    if (typeof invoke !== "function") throw new Error("Missing Native invoke");
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    Reflect.set(
      internals,
      "invoke",
      async (command: string, args: Record<string, unknown> = {}) => {
        const result: unknown = await Reflect.apply(invoke, internals, [
          command,
          args,
        ]);
        if (command === "host_connect_device" && connectedSession)
          return connectedSession;
        const request = args.request;
        if (
          command === "host_request" &&
          object(request) &&
          request.method === "action.query" &&
          object(request.params) &&
          (request.params.actionId === "device.list" ||
            request.params.actionId === "device.refresh")
        )
          return {
            ok: true,
            result: { kind: "devices", value: { devices, stale: false } },
          };
        return result;
      },
    );
    window.workbenchFixture.releaseHost();
  }, JSON.stringify({ devices, connectedSession }));
}

function restartedSerialWorkspace(fingerprint: DeviceFingerprint) {
  const workspace = preset("Serial bench");
  workspace.bindings[0] = {
    ...workspace.bindings[0]!,
    deviceId: "previous-host-com5",
    fingerprint,
  };
  workspace.views[0] = { ...workspace.views[0]!, name: "COM5" };
  workspace.bindings.push({
    ...preset("Virtual bench").bindings[0]!,
    bindingId: "virtual-binding",
  });
  workspace.views.push({
    ...workspace.views[0]!,
    id: "virtual-view",
    name: "Virtual serial",
    bindingId: "virtual-binding",
  });
  const devices: DeviceDescriptor[] = [
    {
      hostId: "workbench-gui-host",
      deviceId: "device",
      systemName: "Virtual serial",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities: session().capabilities,
    },
    {
      hostId: "workbench-gui-host",
      deviceId: "current-host-com5",
      systemName: "COM5",
      fingerprint,
      capabilities: session().capabilities,
    },
  ];
  return { workspace, devices };
}

async function switchWorkspace(page: Page, name: string) {
  const editor = page.getByRole("dialog", { name: "Workspace", exact: true });
  await editor
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  await page.getByRole("option", { name, exact: true }).click();
  const unfinished = page.getByRole("dialog", {
    name: "Save unfinished work",
    exact: true,
  });
  if (await unfinished.isVisible())
    await unfinished
      .getByRole("button", { name: "Discard and continue", exact: true })
      .click();
  await expect(
    editor.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue(name);
  return editor;
}

async function createWorkspace(page: Page, name: string, copy = false) {
  const editor = page.getByRole("dialog", { name: "Workspace", exact: true });
  const action = copy ? "Save workspace as" : "New workspace";
  await editor.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: action, exact: true });
  await dialog
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill(name);
  await dialog
    .getByRole("button", {
      name: copy ? action : "Create workspace",
      exact: true,
    })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue(name);
  return editor;
}

async function saveWorkspace(page: Page) {
  const editor = page.getByRole("dialog", { name: "Workspace", exact: true });
  const save = editor.getByRole("button", {
    name: "Save workspace",
    exact: true,
  });
  await save.click();
  await expect(save).toBeDisabled();
}

test("switching imported workspaces with equal view ids keeps their saved send drafts independent", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    workspace: preset("Bench A"),
    captureTails: { results: {}, workspaces: { other: preset("Bench B") } },
  });
  await page.goto("./#/");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(
    page.getByRole("tab", { name: "Controller", exact: true }),
  ).toBeVisible();
  await draft.fill("COMMAND FOR BENCH A");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some((state) =>
          Object.values(state.drafts).includes("COMMAND FOR BENCH A"),
        ),
      ),
    )
    .toBe(true);
  const editor = await openWorkspace(page);
  await switchWorkspace(page, "Bench B");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await evidence(page, info, "bench-b-before-edit");
  expect
    .soft(
      await draft.inputValue(),
      "Bench B must not inherit a command intended for Bench A",
    )
    .toBe("");
  await draft.fill("COMMAND FOR BENCH B");
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.clientStateWrites.some((state) =>
          Object.values(state.drafts).includes("COMMAND FOR BENCH B"),
        ),
      ),
    )
    .toBe(true);
  await openWorkspace(page);
  await switchWorkspace(page, "Bench A");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await evidence(page, info, "bench-a-after-b-edit");
  expect
    .soft(
      await draft.inputValue(),
      "Bench A must retain its own saved command after editing Bench B",
    )
    .toBe("COMMAND FOR BENCH A");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("workspace format edits replace the temporary toolbar choice and expose the encoding used by each view", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    workspace: preset("Format bench"),
  });
  await page.goto("./#/");
  const receive = page.getByRole("region", { name: "Receive", exact: true });
  await expect(
    page.getByRole("tab", { name: "Controller", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Choose device", exact: true }),
  ).toBeEnabled();
  await receive.getByRole("radio", { name: "HEX", exact: true }).click();
  await expect(
    receive.getByRole("radio", { name: "HEX", exact: true }),
  ).toBeChecked();
  const editor = await openWorkspace(page);
  expect
    .soft(
      await editor
        .getByRole("combobox", { name: "Receive mode", exact: true })
        .textContent(),
      "The workspace editor must reflect the format currently shown in the workbench",
    )
    .toBe("HEX");
  await editor
    .getByRole("combobox", { name: "Receive mode", exact: true })
    .click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
  const save = editor.getByRole("button", {
    name: "Save workspace",
    exact: true,
  });
  if (await save.isEnabled()) {
    await save.click();
    await expect(save).toBeDisabled();
  }
  await evidence(page, info, "saved-text-mode-in-workspace");
  expect
    .soft(
      await editor
        .getByRole("combobox", { name: "Receive encoding", exact: true })
        .count(),
      "Receive encoding belongs beside the saved view format",
    )
    .toBe(1);
  expect
    .soft(
      await editor
        .getByRole("combobox", { name: "Send encoding", exact: true })
        .count(),
      "Send encoding belongs beside the saved view format",
    )
    .toBe(1);
  const receiveEncoding = editor.getByRole("combobox", {
    name: "Receive encoding",
    exact: true,
  });
  const sendEncoding = editor.getByRole("combobox", {
    name: "Send encoding",
    exact: true,
  });
  const encodingControls =
    (await receiveEncoding.count()) === 1 && (await sendEncoding.count()) === 1;
  if (encodingControls) {
    await receiveEncoding.click();
    await page.getByRole("option", { name: "GBK", exact: true }).click();
    await sendEncoding.click();
    await page.getByRole("option", { name: "GBK", exact: true }).click();
    await saveWorkspace(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.workspaceWrites.at(-1)?.views[0]
              ?.receiveEncoding,
        ),
      )
      .toBe("gbk");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.workspaceWrites.at(-1)?.views[0]
              ?.sendEncoding,
        ),
      )
      .toBe("gbk");
    await evidence(page, info, "workspace-saved-gbk-encodings");
    await writeFile(
      info.outputPath("saved-workspace-encodings.json"),
      JSON.stringify(
        await page.evaluate(() =>
          window.workbenchFixture.workspaceWrites.at(-1),
        ),
        null,
        2,
      ),
    );
  }
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await evidence(page, info, "toolbar-after-saved-text-mode");
  expect
    .soft(
      await receive
        .getByRole("radio", { name: "Text", exact: true })
        .isChecked(),
      "The saved Text choice must apply to the current view immediately",
    )
    .toBe(true);
  if (encodingControls) {
    await expect(
      receive.getByRole("combobox", { name: "Receive encoding", exact: true }),
    ).toHaveText("GBK");
    await expect(
      page
        .getByRole("region", { name: "Send", exact: true })
        .getByRole("combobox", { name: "Send encoding", exact: true }),
    ).toHaveText("GBK");
  }
});

test("a person can create two views, discard an edit, save a copy, switch between them and delete the copy", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    sidebarCollapsed: true,
    workspace: { ...defaults.workspace, name: "Default workspace" },
  });
  await page.goto("./#/");
  const editor = await openWorkspace(page);
  await createWorkspace(page, "Lab A");
  await editor
    .getByRole("combobox", { name: "Choose a serial port", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Virtual serial", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Add serial view", exact: true })
    .click();
  await editor
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Controller");
  await editor.getByRole("button", { name: "Clone view", exact: true }).click();
  await editor
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Sensor");
  await saveWorkspace(page);
  await evidence(page, info, "lab-a-two-saved-views");

  await editor
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Scratch edit to discard");
  await editor
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "View name", exact: true }),
  ).toHaveValue("Sensor");
  await createWorkspace(page, "Lab B", true);
  await editor.getByRole("combobox", { name: "Views", exact: true }).click();
  await page.getByRole("option", { name: "Sensor", exact: true }).click();
  await editor
    .getByRole("button", { name: "Remove view", exact: true })
    .click();
  await saveWorkspace(page);
  await evidence(page, info, "lab-b-copy-with-one-view");
  await switchWorkspace(page, "Lab A");
  await editor.getByRole("combobox", { name: "Views", exact: true }).click();
  await page.getByRole("option", { name: "Sensor", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "View name", exact: true }),
  ).toHaveValue("Sensor");
  await editor.press("Escape");
  await expect(editor).toBeHidden();

  await page.getByRole("tab", { name: "Controller", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await draft.fill("CONTROLLER COMMAND");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save drafts", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "Sensor", exact: true }).click();
  await draft.fill("SENSOR COMMAND");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save drafts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save drafts", exact: true }),
  ).toBeDisabled();
  await evidence(page, info, "lab-a-shared-connection-independent-drafts");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual(["device"]);

  await openWorkspace(page);
  await switchWorkspace(page, "Lab B");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await expect(draft).toHaveValue("");
  await openWorkspace(page);
  await switchWorkspace(page, "Lab A");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("tab", { name: "Controller", exact: true }).click();
  await expect(draft).toHaveValue("CONTROLLER COMMAND");
  await page.getByRole("tab", { name: "Sensor", exact: true }).click();
  await expect(draft).toHaveValue("SENSOR COMMAND");
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Sensor", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Controller", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await openWorkspace(page);
  await switchWorkspace(page, "Lab B");
  await editor
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete workspace", exact: true })
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Default workspace");
  await editor
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Lab B", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "Lab A", exact: true }).click();
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await evidence(page, info, "after-copy-delete-original-retained");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("deleting a workspace returns to an editable default after its asynchronous read completes", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    workspace: { ...defaults.workspace, name: "Default workspace" },
  });
  await page.goto("./#/");
  const editor = await openWorkspace(page);
  await editor
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "New workspace",
    exact: true,
  });
  await create
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill("Bench to delete");
  await create
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Bench to delete");
  await evidence(page, info, "before-delete");

  // 只延迟 Native 读取边界，实际删除、父级选中状态、取消和恢复均走生产代码。
  await page.evaluate(() => {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (typeof internals !== "object" || internals === null)
      throw new Error("Missing Native fixture");
    const invoke: unknown = Reflect.get(internals, "invoke");
    if (typeof invoke !== "function") throw new Error("Missing Native invoke");
    let release: (() => void) | undefined;
    const gate = {
      defaultReadStarted: false,
      releaseDefault: () => release?.(),
      events: [] as string[],
    };
    window.workspaceWorkflowGate = gate;
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    Reflect.set(
      internals,
      "invoke",
      async (command: string, args: Record<string, unknown> = {}) => {
        const request = args.request;
        if (
          command === "host_request" &&
          object(request) &&
          request.method === "action.query" &&
          object(request.params) &&
          request.params.actionId === "workspace.read" &&
          object(request.params.target) &&
          request.params.target.id === "default"
        ) {
          gate.events.push("default-read-started");
          gate.defaultReadStarted = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          gate.events.push("default-read-released");
        }
        return Reflect.apply(invoke, internals, [command, args]);
      },
    );
  });

  await editor
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Delete workspace",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workspaceWorkflowGate?.defaultReadStarted),
    )
    .toBe(true);
  await evidence(page, info, "default-read-pending-after-delete");
  await page.evaluate(() => window.workspaceWorkflowGate?.releaseDefault());
  await writeFile(
    info.outputPath("native-delay-events.json"),
    JSON.stringify(
      await page.evaluate(() => window.workspaceWorkflowGate?.events),
      null,
      2,
    ),
  );
  await expect(
    editor.getByRole("combobox", { name: "Choose workspace", exact: true }),
  ).toHaveText("Default workspace");
  const name = editor.getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await expect(name).toBeEditable();
  await name.fill("Default workspace edited after delete");
  await expect(
    editor.getByRole("button", { name: "Save workspace", exact: true }),
  ).toBeEnabled();
  await evidence(page, info, "default-editable-after-delete");
});

test("a narrow light workspace shows the second view and its independent text encodings in Chinese", async ({
  page,
}, info) => {
  const workspace = preset("双设备方案");
  workspace.views.push({
    ...workspace.views[0]!,
    id: "second-view",
    name: "传感器",
    receiveEncoding: "gbk",
    sendEncoding: "gb18030",
  });
  await page.setViewportSize({ width: 640, height: 720 });
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "light",
    workspace,
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "工作区", exact: true });
  await editor.getByRole("combobox", { name: "视图", exact: true }).click();
  await page.getByRole("option", { name: "传感器", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "视图名称", exact: true }),
  ).toHaveValue("传感器");
  await expect(
    editor.getByRole("combobox", { name: "接收编码", exact: true }),
  ).toHaveText("GBK");
  await expect(
    editor.getByRole("combobox", { name: "发送编码", exact: true }),
  ).toHaveText("GB18030");
  expect(
    await editor.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await evidence(page, info, "workspace-zh-light-narrow-second-view");
});

test("a saved serial identity follows the selected view after Host device ids change without opening a port", async ({
  page,
}, info) => {
  const { workspace, devices } = restartedSerialWorkspace({
    transport: "serial",
    evidence: "serialNumber",
    serialNumber: "LOOPBACK-ADAPTER-5",
    vid: 0x1a86,
    pid: 0x7523,
    topologyPath: "usb/1/5",
  });
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    hostStart: "pending",
    workspace,
  });
  await page.goto("./#/");
  await provideDeviceCatalog(page, devices);
  const choose = page.getByRole("combobox", {
    name: "Choose device",
    exact: true,
  });
  const serialView = page.getByRole("tab", { name: "COM5", exact: true });
  const virtualView = page.getByRole("tab", {
    name: "Virtual serial",
    exact: true,
  });
  await expect(serialView).toHaveAttribute("aria-selected", "true");
  await expect(choose).toHaveText("COM5");
  await expect(
    page.getByRole("button", { name: "Open COM5", exact: true }),
  ).toBeEnabled();

  await choose.click();
  await page
    .getByRole("option", { name: "Virtual serial", exact: true })
    .click();
  await expect(choose).toHaveText("Virtual serial");
  await virtualView.click();
  await expect(choose).toHaveText("Virtual serial");
  await serialView.click();
  await expect(choose).toHaveText("COM5");
  await virtualView.click();
  await expect(choose).toHaveText("Virtual serial");
  await serialView.click();
  await expect(choose).toHaveText("COM5");
  await choose.click();
  await expect(
    page.getByRole("option", { name: "COM5", exact: true }),
  ).toBeEnabled();
  await evidence(page, info, "restarted-serial-catalog-en-dark");
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await evidence(page, info, "restarted-serial-selection-en-dark");
});

test("saved weak ports preselect by name across renamed views, refresh and reload, then connect only on request", async ({
  page,
}, info) => {
  const { workspace, devices } = restartedSerialWorkspace({
    transport: "serial",
    evidence: "unreliable",
  });
  workspace.bindings[0]!.configuration.baudRate = "9600";
  workspace.bindings.push({
    ...workspace.bindings[0]!,
    bindingId: "renamed-binding",
    portName: "COM5",
  });
  workspace.views.push({
    ...workspace.views[0]!,
    id: "renamed-view",
    name: "温度传感器",
    bindingId: "renamed-binding",
  });
  const connectedSession: SessionSnapshot = {
    ...session("fresh-com5-session"),
    deviceId: "current-host-com5",
    configuration: { ...workspace.bindings[0]!.configuration },
  };
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "light",
    hostStart: "pending",
    workspace,
  });
  await page.goto("./#/");
  await provideDeviceCatalog(page, devices, connectedSession);
  const choose = page.getByRole("combobox", {
    name: "选择设备",
    exact: true,
  });
  await expect(
    page.getByRole("tab", { name: "COM5", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(choose).toHaveText("COM5");
  await choose.click();
  await expect(page.getByRole("option", { name: /COM5/ })).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "COM5", exact: true }),
  ).toBeEnabled();
  await evidence(page, info, "weak-port-name-catalog-zh-light");
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "工作区", exact: true });
  const viewName = editor.getByRole("textbox", {
    name: "视图名称",
    exact: true,
  });
  await expect(viewName).toHaveValue("COM5");
  await viewName.fill("回环串口");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.workspaceWrites
          .at(-1)
          ?.bindings.find((binding) => binding.bindingId === "shared-binding"),
      ),
    )
    .toMatchObject({
      portName: "COM5",
      deviceId: "previous-host-com5",
      fingerprint: { transport: "serial", evidence: "unreliable" },
      configuration: { baudRate: "9600" },
    });
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("tab", { name: "回环串口", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(choose).toHaveText("COM5");
  await page.getByRole("tab", { name: "温度传感器", exact: true }).click();
  await expect(choose).toHaveText("COM5");
  await expect(
    page.getByRole("button", { name: "打开 COM5", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toHaveLength(1);
  await evidence(page, info, "renamed-port-selected-zh-light");

  await page.reload();
  await provideDeviceCatalog(page, devices, connectedSession);
  await expect(
    page.getByRole("tab", { name: "回环串口", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(choose).toHaveText("COM5");
  await page.getByRole("tab", { name: "温度传感器", exact: true }).click();
  await expect(choose).toHaveText("COM5");
  await page.getByRole("tab", { name: "回环串口", exact: true }).click();
  await expect(choose).toHaveText("COM5");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
  await page.getByRole("button", { name: "打开 COM5", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.connectRequests))
    .toEqual([
      {
        deviceId: "current-host-com5",
        params: { configuration: connectedSession.configuration },
      },
    ]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.queryInputs.some(
          (query) =>
            query.actionId === "action.check" &&
            query.target.sessionId === "fresh-com5-session",
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "关闭会话", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
  await evidence(page, info, "weak-port-explicitly-connected-zh-light");
});

test("missing saved ports and ports on another Host stay explicitly unmatched while the current local port remains selectable", async ({
  page,
}, info) => {
  const { workspace, devices } = restartedSerialWorkspace({
    transport: "serial",
    evidence: "unreliable",
  });
  workspace.bindings[0] = {
    ...workspace.bindings[0]!,
    portName: "COM99",
  };
  workspace.views[0] = { ...workspace.views[0]!, name: "COM99" };
  workspace.bindings.push({
    ...workspace.bindings[0]!,
    bindingId: "remote-binding",
    hostId: "other-host",
    portName: "COM5",
  });
  workspace.views.push({
    ...workspace.views[0]!,
    id: "remote-view",
    name: "Remote COM5",
    bindingId: "remote-binding",
  });
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "dark",
    hostStart: "pending",
    workspace,
  });
  await page.goto("./#/");
  await provideDeviceCatalog(page, devices);
  const choose = page.getByRole("combobox", {
    name: "Choose device",
    exact: true,
  });
  await expect(choose).toHaveText("COM99 · Unmatched");
  await expect(
    page.getByRole("button", { name: "Open", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "Remote COM5", exact: true }).click();
  await expect(choose).toHaveText("Remote COM5 · Unmatched");
  await choose.click();
  await expect(
    page.getByRole("option", { name: "Remote COM5 · Unmatched", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("option", { name: "COM5", exact: true }),
  ).toBeEnabled();
  await evidence(page, info, "missing-and-cross-host-ports-unmatched-en-dark");
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.workspaceWrites),
  ).toEqual([]);
});
