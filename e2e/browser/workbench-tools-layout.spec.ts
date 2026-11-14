/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { session } from "../../src/features/workbench/test-fixtures";
import type { WorkspaceDocument } from "@serial-workbench/contracts";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };

async function openTool(page: Page, name: string) {
  const menu = page.getByRole("button", {
    name: /Workspace menu|工作区菜单/,
    exact: true,
  });
  // 等前一个模态工具完成关闭与 aria 隔离清理，再判断当前宽度的实际入口。
  await expect(menu).toBeVisible();
  const direct = page.getByRole("button", { name, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await menu.focus();
    await menu.press("ArrowDown");
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
}

for (const language of ["en", "zh"] as const) {
  test(`restored views reconnect in place and keep independent drafts (${language})`, async ({
    page,
  }, info) => {
    const dictionary = language === "zh" ? zhCN : en;
    const workspace: WorkspaceDocument = {
      ...defaults.workspace,
      name: "Reconnection bench",
      bindings: [
        {
          bindingId: "retired-binding",
          hostId: "retired-host",
          deviceId: "device",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          configuration: session().configuration,
          reconnect: { enabled: false, maxDelayMs: "30000", maxAttempts: "10" },
        },
        {
          bindingId: "current-binding",
          hostId: "workbench-gui-host",
          deviceId: "device",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          configuration: session().configuration,
          reconnect: { enabled: false, maxDelayMs: "30000", maxAttempts: "10" },
        },
      ],
      views: ["Rebound view", "Shared view"].map((name, index) => ({
        id: index === 0 ? "saved-view" : "shared-view",
        name,
        bindingId: index === 0 ? "retired-binding" : "current-binding",
        color: "#7C3AED",
        icon: "terminal",
        pinned: false,
        receiveMode: "text",
        sendMode: "text",
      })),
    };
    await seedWorkbenchFixture(page, {
      language,
      theme: language === "zh" ? "dark" : "light",
      workspace,
      drafts: { "saved-view": "retained-draft" },
    });
    await page.goto("./#/");
    const choose = page.getByRole("combobox", {
      name: dictionary["workbench.tools.chooseDevice"],
      exact: true,
    });
    const send = page.getByRole("button", {
      name: dictionary["workbench.send"],
      exact: true,
    });
    const draft = page.getByRole("textbox", {
      name: dictionary["workbench.draft"],
      exact: true,
    });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(send).toBeDisabled();
    await choose.click();
    await page
      .getByRole("option", { name: "Virtual serial", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: `${dictionary["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("tab", { name: "Rebound view", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(draft).toHaveValue("retained-draft");
    await expect(send).toBeEnabled();
    await send.click();
    await page.getByRole("tab", { name: "Shared view", exact: true }).click();
    await expect(draft).toHaveValue("");
    await draft.fill("shared-draft");
    await expect(send).toBeEnabled();
    await send.click();
    await page.getByRole("tab", { name: "Rebound view", exact: true }).click();
    await expect(draft).toHaveValue("retained-draft");
    await page
      .getByRole("button", {
        name: dictionary["workbench.tools.saveCurrentLayout"],
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.workspaceWrites.length),
      )
      .toBe(1);
    const result = await page.evaluate(() => ({
      saved: window.workbenchFixture.workspaceWrites[0]!,
      connected: window.workbenchFixture.connectCalls,
      sent: window.workbenchFixture.sentBytes,
      raw: window.workbenchFixture.rawSubscriptions,
    }));
    expect(result.connected).toHaveLength(1);
    expect(result.sent).toEqual([btoa("retained-draft"), btoa("shared-draft")]);
    expect(result.raw).toHaveLength(1);
    expect(result.saved.views.map((view) => view.id)).toEqual([
      "saved-view",
      "shared-view",
    ]);
    for (const view of result.saved.views)
      expect(
        result.saved.bindings.find(
          (binding) => binding.bindingId === view.bindingId,
        ),
      ).toMatchObject({
        hostId: "workbench-gui-host",
        deviceId: "device",
      });
    await expect(send).toBeEnabled();
    await openTool(page, dictionary["workbench.tools.workspace"]);
    const editor = page.getByRole("dialog", {
      name: dictionary["workbench.tools.workspace"],
      exact: true,
    });
    await expect(
      editor.getByRole("button", {
        name: dictionary["workbench.tools.save"],
        exact: true,
      }),
    ).toBeDisabled();
    await editor.press("Escape");
    await expect(editor).toBeHidden();
    await page.screenshot({
      path: info.outputPath(`workspace-reconnected-${language}.png`),
    });
  });
}

test("connected tabs can be edited and saved as a workspace directly without a separate layout save", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
  await openTool(page, "Workspace");
  const editor = page.getByRole("dialog", { name: "Workspace", exact: true });
  await expect(
    editor.getByRole("combobox", { name: "Views", exact: true }),
  ).toHaveText("Virtual serial");
  await editor
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Controller");
  await editor.getByLabel("Baud rate", { exact: true }).fill("57600");
  await editor
    .getByRole("button", { name: "Save workspace as", exact: true })
    .click();
  const copy = page.getByRole("dialog", {
    name: "Save workspace as",
    exact: true,
  });
  await copy
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Daily bench");
  await copy
    .getByRole("button", { name: "Save workspace as", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Daily bench");
  await expect(
    editor.getByRole("combobox", { name: "Views", exact: true }),
  ).toHaveText("Controller");
  const saved = await page.evaluate(() =>
    window.workbenchFixture.workspaceWrites.at(-1),
  );
  expect(saved?.views).toHaveLength(1);
  expect(saved?.bindings[0]?.deviceId).toBe("device");
  expect(saved?.views[0]?.name).toBe("Controller");
  expect(saved?.bindings[0]?.configuration.baudRate).toBe("57600");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await page
    .getByRole("textbox", { name: "Send draft", exact: true })
    .fill("probe");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await openTool(page, "Workspace");
  await editor.getByRole("button", { name: "Clone view", exact: true }).click();
  await editor
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Save workspace", exact: true }),
  ).toBeDisabled();
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("tab", { name: "Controller (2)", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Send draft", exact: true })
    .fill("probe");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toHaveLength(1);
});

test("a new workspace can configure and distinguish serial views without connecting hardware", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, { language: "zh", theme: "dark" });
  await page.goto("./#/");
  await openTool(page, "工作区");
  const editor = page.getByRole("dialog", { name: "工作区", exact: true });
  await editor.getByRole("button", { name: "新建工作区", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await create
    .getByRole("textbox", { name: "工作区名称", exact: true })
    .fill("设备方案");
  await create.getByRole("button", { name: "创建工作区", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "工作区名称", exact: true }),
  ).toHaveValue("设备方案");
  await editor.getByRole("combobox", { name: "选择串口", exact: true }).click();
  await page
    .getByRole("option", { name: "Virtual serial", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "添加串口视图", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "视图名称", exact: true }),
  ).toHaveValue("Virtual serial");
  await editor.getByRole("button", { name: "克隆视图", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "视图名称", exact: true }),
  ).toHaveValue("Virtual serial (2)");
  await editor.getByRole("combobox", { name: "视图", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Virtual serial (2)", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "Virtual serial (2)", exact: true })
    .click();
  const switchBox = await editor
    .getByRole("switch", { name: "已固定", exact: true })
    .boundingBox();
  const inputBox = await editor
    .getByRole("textbox", { name: "视图名称", exact: true })
    .boundingBox();
  expect(
    Math.abs(switchBox!.x + switchBox!.width - inputBox!.x - inputBox!.width),
  ).toBeLessThan(2);
  await editor.getByRole("button", { name: "移除视图", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "视图名称", exact: true }),
  ).toHaveValue("Virtual serial");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.workbenchFixture.workspaceWrites.at(-1)?.views.length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  await editor.screenshot({
    path: info.outputPath("configured-offline-workspace.png"),
  });
});

test("workspace management creates independent copies and keeps its saved directory after refresh", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    workspace: { ...defaults.workspace, name: "Original bench" },
  });
  await page.goto("./#/");
  await openTool(page, "Workspace");
  const dialog = page.getByRole("dialog", { name: "Workspace", exact: true });
  await dialog
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill("Unsaved original edit");
  await dialog
    .getByRole("button", { name: "Save workspace as", exact: true })
    .click();
  const copy = page.getByRole("dialog", {
    name: "Save workspace as",
    exact: true,
  });
  await copy
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Copied bench");
  await copy.screenshot({ path: info.outputPath("workspace-save-as.png") });
  await copy
    .getByRole("button", { name: "Save workspace as", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Copied bench");
  await dialog
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Original bench", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Original bench");
  await dialog
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "New workspace",
    exact: true,
  });
  await create
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Blank bench");
  await create
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Blank bench");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.workspaceWrites.map((item) => item.name),
      ),
    )
    .toEqual(["Copied bench", "Blank bench"]);
  await page.reload();
  await openTool(page, "Workspace");
  await dialog
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  for (const name of ["Original bench", "Copied bench", "Blank bench"])
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Copied bench", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Copied bench");
  await dialog.screenshot({
    path: info.outputPath("workspace-directory-restored.png"),
  });
  expect(
    await page.evaluate(() => window.workbenchFixture.connectCalls),
  ).toEqual([]);
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
});

test("workspace selection restores its display modes and uses its connection preset at the Native boundary", async ({
  page,
}) => {
  const preset = (name: string, baudRate: string): WorkspaceDocument => ({
    name,
    layout: { sidebarWidth: 224, panelHeight: 192 },
    captures: [],
    favoriteBindingIds: [],
    bindings: [
      {
        bindingId: "binding",
        hostId: "workbench-gui-host",
        deviceId: "device",
        fingerprint: { transport: "virtual", evidence: "unreliable" },
        configuration: { ...session().configuration, baudRate },
        reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
      },
    ],
    views: [
      {
        id: "view",
        bindingId: "binding",
        name: "Controller",
        color: "#2266AA",
        icon: "terminal",
        pinned: false,
        receiveMode: "text",
        sendMode: "text",
      },
    ],
  });
  await seedWorkbenchFixture(page, {
    workspace: preset("Bench A", "9600"),
    connectionDefaults: [
      {
        hostId: "workbench-gui-host",
        deviceId: "device",
        configuration: { ...session().configuration, baudRate: "115200" },
      },
    ],
    captureTails: {
      results: {},
      workspaces: { other: preset("Bench B", "57600") },
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("region", { name: "Receive", exact: true })
    .getByRole("radio", { name: "HEX", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Send", exact: true })
    .getByRole("radio", { name: "HEX", exact: true })
    .click();
  await openTool(page, "Workspace");
  const dialog = page.getByRole("dialog", { name: "Workspace", exact: true });
  await dialog
    .getByRole("combobox", { name: "Choose workspace", exact: true })
    .click();
  await page.getByRole("option", { name: "Bench B", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Save unfinished work", exact: true })
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Workspace name", exact: true }),
  ).toHaveValue("Bench B");
  await expect(
    dialog.getByRole("combobox", { name: "Device binding", exact: true }),
  ).toHaveText("Virtual serial · 57600");
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Receive", exact: true })
      .getByRole("radio", { name: "Text", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "Send", exact: true })
      .getByRole("radio", { name: "Text", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.connectRequests))
    .toMatchObject([
      { deviceId: "device", params: { configuration: { baudRate: "57600" } } },
    ]);
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
});

for (const sample of [
  { language: "en", theme: "light", width: 1400, height: 925 },
  { language: "zh", theme: "dark", width: 880, height: 600 },
  { language: "zh", theme: "dark", width: 640, height: 720 },
] as const) {
  test(`workspace view controls save visual choices and fit ${sample.width}px in ${sample.language}`, async ({
    page,
  }, info) => {
    const dictionary = sample.language === "zh" ? zhCN : en;
    const t = (key: keyof typeof en) => dictionary[key];
    const workspace: WorkspaceDocument = {
      name: "Bench",
      layout: { sidebarWidth: 224, panelHeight: 192 },
      captures: [],
      favoriteBindingIds: [],
      bindings: [
        {
          bindingId: "binding",
          hostId: "workbench-gui-host",
          deviceId: "device",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          configuration: session().configuration,
          reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
        },
      ],
      views: [
        {
          id: "view",
          name: "Controller",
          color: "#2266AA",
          icon: "★",
          pinned: false,
          receiveMode: "text",
          sendMode: "text",
          bindingId: "binding",
        },
      ],
    };
    await page.setViewportSize(sample);
    await seedWorkbenchFixture(page, {
      language: sample.language,
      theme: sample.theme,
      workspace,
    });
    await page.goto("./#/");
    await openTool(page, t("workbench.tools.workspace"));
    const dialog = page.getByRole("dialog", {
      name: t("workbench.tools.workspace"),
      exact: true,
    });
    await expect(
      dialog.getByRole("textbox", {
        name: t("workbench.tools.viewName"),
        exact: true,
      }),
    ).toHaveValue("Controller");
    await expect(
      dialog
        .getByRole("combobox", {
          name: t("workbench.tools.chooseWorkspace"),
          exact: true,
        })
        .locator("svg"),
    ).toHaveCount(2);
    const geometry = await dialog.evaluate((element) => {
      const view = element
        .querySelector(".workbench-workspace-view-fields")!
        .getBoundingClientRect();
      const configuration = element
        .querySelector(".workbench-workspace-configuration")!
        .getBoundingClientRect();
      const scroll = element
        .querySelector(".workbench-workspace-content")!
        .getBoundingClientRect();
      return {
        view: view.toJSON(),
        configuration: configuration.toJSON(),
        scrollbarInset: element.getBoundingClientRect().right - scroll.right,
        controlGaps: [
          ...element.querySelectorAll(
            '.workbench-workspace-editor [role="combobox"]',
          ),
        ]
          .filter(
            (control) => !control.closest(".workbench-workspace-add-view"),
          )
          .map((control) => {
            const row = control.closest("label, .workbench-form-row")!;
            return (
              row.getBoundingClientRect().right -
              control.getBoundingClientRect().right
            );
          }),
        actions: [
          ...element.querySelectorAll(".workbench-workspace-actions > button"),
        ].map((button) => button.getBoundingClientRect().height),
      };
    });
    if (sample.width >= 880)
      expect(geometry.configuration.left).toBeGreaterThan(geometry.view.right);
    else
      expect(geometry.configuration.top).toBeGreaterThan(geometry.view.bottom);
    expect(geometry.scrollbarInset).toBeLessThanOrEqual(8);
    for (const gap of geometry.controlGaps)
      expect(Math.abs(gap)).toBeLessThanOrEqual(1);
    expect(
      Math.max(...geometry.actions) - Math.min(...geometry.actions),
    ).toBeLessThan(1);
    await dialog.screenshot({ path: info.outputPath("workspace-edit.png") });

    await dialog
      .getByRole("button", {
        name: t("workbench.tools.chooseColor"),
        exact: true,
      })
      .click();
    const hue = page.getByRole("slider", {
      name: t("settings.customAccentHue"),
      exact: true,
    });
    await hue.press("ArrowRight");
    const selectedColor = await dialog
      .getByRole("textbox", { name: t("workbench.tools.color"), exact: true })
      .inputValue();
    expect(selectedColor).not.toBe("#2266AA");
    await page.screenshot({
      path: info.outputPath("workspace-color.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    const icon = dialog.getByRole("button", {
      name: t("workbench.tools.icon"),
      exact: true,
    });
    await expect(icon).toContainText("★");
    await icon.click();
    const custom = page.getByRole("textbox", {
      name: t("workbench.tools.customIcon"),
      exact: true,
    });
    await expect(custom).toHaveValue("★");
    await custom.fill("☆");
    await page.keyboard.press("Escape");
    await expect(icon).toContainText("☆");
    await icon.click();
    const chip = page.getByRole("button", {
      name: t("workbench.tools.iconCpu"),
      exact: true,
    });
    const iconSvg = await chip.locator("svg").innerHTML();
    await page.screenshot({
      path: info.outputPath("workspace-icons.png"),
      animations: "disabled",
    });
    await chip.click();
    await dialog
      .getByRole("switch", { name: t("workbench.tools.pinned"), exact: true })
      .click();
    await dialog
      .getByRole("button", { name: t("workbench.tools.save"), exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workbenchFixture.workspaceWrites.at(-1)?.views[0],
        ),
      )
      .toMatchObject({ icon: "cpu", pinned: true, color: selectedColor });
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByRole("tab", { name: /Controller/ })
        .locator("svg")
        .first(),
    ).toHaveJSProperty("innerHTML", iconSvg);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}

for (const sample of [
  {
    language: "en" as const,
    theme: "light" as const,
    width: 1120,
    height: 744,
  },
  { language: "zh" as const, theme: "dark" as const, width: 880, height: 600 },
]) {
  test(`device and workspace tools keep fixed frames and readable controls (${sample.language}/${sample.theme})`, async ({
    page,
  }, info) => {
    const dictionary = sample.language === "zh" ? zhCN : en;
    const t = (key: keyof typeof en) => dictionary[key];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, {
      language: sample.language,
      theme: sample.theme,
      sidebarCollapsed: false,
    });
    await page.goto("./#/");
    await expect(
      page.getByRole("button", {
        name: /Open Virtual serial|打开 Virtual serial/,
      }),
    ).toBeEnabled();
    await openTool(page, t("workbench.tools.devices"));
    let dialog = page.getByRole("dialog", {
      name: t("workbench.tools.devices"),
      exact: true,
    });
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const deviceFrame = await dialog.boundingBox();
    for (const [index, key] of (
      [
        "workbench.tools.onlineDevices",
        "workbench.tools.recentConnections",
        "workbench.tools.favorites",
      ] as const
    ).entries()) {
      const tab = dialog.getByRole("tab", { name: t(key), exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      if (index === 1)
        await expect(
          dialog.getByRole("tabpanel").locator("time"),
        ).toHaveAttribute("datetime", "2026-11-10T06:15:00Z");
      expect(await dialog.boundingBox()).toEqual(deviceFrame);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await expect(
        dialog.getByRole("button", {
          name: t("workbench.tools.refreshRecent"),
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(dialog).not.toContainText("unreliable");
      await dialog.screenshot({
        path: info.outputPath(`devices-${index}.png`),
      });
    }
    expect(
      await page.evaluate(() =>
        window.workbenchFixture.hostQueries.includes("recent.list"),
      ),
    ).toBe(true);
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await openTool(page, t("workbench.tools.workspace"));
    dialog = page.getByRole("dialog", {
      name: t("workbench.tools.workspace"),
      exact: true,
    });
    await expect(
      dialog.getByRole("combobox", {
        name: t("workbench.tools.chooseWorkspace"),
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole("combobox", {
        name: t("workbench.tools.chooseWorkspace"),
        exact: true,
      }),
    ).toHaveText(t("workbench.tools.defaultWorkspace"));
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const workspaceFrame = await dialog.boundingBox();
    const workspaceName = dialog.getByRole("textbox", {
      name: t("workbench.tools.workspaceName"),
      exact: true,
    });
    await expect(workspaceName).toHaveValue("");
    await expect(workspaceName).toHaveAttribute(
      "placeholder",
      t("workbench.tools.defaultWorkspace"),
    );
    await expect(
      dialog.getByRole("textbox", {
        name: t("workbench.tools.workspaceId"),
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
    const workspaceAction = await dialog
      .getByRole("button", { name: t("workbench.tools.save"), exact: true })
      .boundingBox();
    expect(workspaceAction).not.toBeNull();
    for (const control of [
      workspaceName,
      dialog.getByRole("combobox", {
        name: t("workbench.tools.chooseWorkspace"),
        exact: true,
      }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.height - workspaceAction!.height)).toBeLessThan(1);
    }
    await dialog.screenshot({ path: info.outputPath("workspace-general.png") });
    await dialog
      .getByRole("button", { name: t("workbench.tools.import"), exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: t("workbench.tools.chooseConfigurationFile"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: t("workbench.tools.previewImport"),
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("textbox", {
        name: t("workbench.tools.workspaceName"),
        exact: true,
      }),
    ).toHaveCount(0);
    expect(await dialog.boundingBox()).toEqual(workspaceFrame);
    await expect(dialog).not.toContainText("JSON");
    const importPicker = await dialog
      .locator(".workbench-workspace-import-file .workbench-file-selection")
      .evaluate((element) => {
        const output = element.querySelector("output");
        const button = element.querySelector("button");
        if (!output || !button)
          throw new Error("Configuration picker incomplete");
        const a = output.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        return {
          compositeHeight: element.getBoundingClientRect().height,
          fieldHeight: a.height,
          buttonHeight: b.height,
          buttonWidth: b.width,
          centerDifference: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
        };
      });
    expect(
      Math.abs(importPicker.fieldHeight - importPicker.buttonHeight),
    ).toBeLessThan(1);
    expect(
      Math.abs(importPicker.compositeHeight - workspaceAction!.height),
    ).toBeLessThan(1);
    expect(
      Math.abs(importPicker.buttonWidth - importPicker.buttonHeight),
    ).toBeLessThan(1);
    expect(importPicker.centerDifference).toBeLessThan(1);
    await dialog.screenshot({ path: info.outputPath("workspace-import.png") });
    await dialog
      .getByRole("button", {
        name: t("workbench.tools.cancelImport"),
        exact: true,
      })
      .click();
    expect(await dialog.boundingBox()).toEqual(workspaceFrame);
    await workspaceName.fill("Workspace");
    await dialog
      .getByRole("button", { name: t("workbench.tools.save"), exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workbenchFixture.workspaceWrites.at(-1)?.name,
        ),
      )
      .toBe("Workspace");
    await expect(workspaceName).toHaveValue("Workspace");
    await expect(
      dialog.getByRole("combobox", {
        name: t("workbench.tools.chooseWorkspace"),
        exact: true,
      }),
    ).toHaveText("Workspace");
    await dialog.press("Escape");
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}

test("opening and changing views preserves the receive and send rectangles", async ({
  page,
}, testInfo) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  const rectangles = () =>
    page.evaluate(() =>
      [
        ".workbench-stream-log",
        ".workbench-draft",
        ".workbench-send-button",
      ].map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    );
  await expect(
    page.getByRole("button", { name: "Open Virtual serial", exact: true }),
  ).toBeEnabled();
  const before = await rectangles();
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  expect(await rectangles()).toEqual(before);
  await page.getByRole("button", { name: "New view", exact: true }).click();
  expect(await rectangles()).toEqual(before);
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  expect(await rectangles()).toEqual(before);
  await expect(page.getByRole("tab")).toHaveCount(0);
  const open = page.getByRole("button", {
    name: "Open Virtual serial",
    exact: true,
  });
  await expect(open).toBeEnabled();
  await expect(open).not.toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("combobox", { name: "Choose device", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("stable-view-layout.png"),
  });
});

for (const sample of [
  { theme: "light" as const, width: 1120, height: 744 },
  { theme: "dark" as const, width: 880, height: 600 },
]) {
  test(`tool forms use aligned rows and fixed pages (${sample.theme})`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, {
      theme: sample.theme,
      sidebarCollapsed: false,
    });
    await page.goto("./#/");
    await page
      .getByRole("button", { name: "Open Virtual serial", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Close session", exact: true }),
    ).toBeEnabled();
    for (const name of ["File transfer", "Capture and replay tools"]) {
      await openTool(page, name);
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeVisible();
      await dialog.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      const footer = dialog.locator(".workbench-tool-footer");
      const footerBox = await footer.boundingBox();
      expect(footerBox).not.toBeNull();
      let columns: { labelX: number; controlX: number } | undefined;
      for (const tab of name === "File transfer"
        ? ["General", "Advanced"]
        : ["Recording", "Playback and repair", "Advanced"]) {
        await dialog.getByRole("tab", { name: tab, exact: true }).click();
        expect(await dialog.boundingBox()).toEqual(box);
        expect(await footer.boundingBox()).toEqual(footerBox);
        const layout = await dialog.evaluate((element) => {
          const body = element.querySelector(
            ".workbench-tool-page[data-state='active']",
          );
          if (!body) throw new Error("Active tool page missing");
          const rows = Array.from(
            body.querySelectorAll(
              ".workbench-form-fields > :is(label, .workbench-form-row)",
            ),
            (label) => {
              const input =
                label.querySelector(".workbench-file-selection") ??
                label.querySelector(
                  "input:not([type='checkbox']),select,[role='combobox'],output",
                );
              const caption = label.querySelector("span");
              if (!input || !caption) return null;
              const a = caption.getBoundingClientRect(),
                b = input.getBoundingClientRect();
              return {
                labelX: a.x,
                controlX: b.x,
                controlHeight: b.height,
                bottomOverflow: b.bottom - body.getBoundingClientRect().bottom,
                centerDifference: Math.abs(
                  a.y + a.height / 2 - b.y - b.height / 2,
                ),
              };
            },
          ).filter((value) => value !== null);
          const pickers = Array.from(
            body.querySelectorAll(".workbench-file-selection"),
            (picker) => {
              const file = picker.querySelector("output");
              const button = picker.querySelector("button");
              if (!file || !button) throw new Error("File picker incomplete");
              const a = file.getBoundingClientRect();
              const b = button.getBoundingClientRect();
              return {
                compositeHeight: picker.getBoundingClientRect().height,
                fieldRight: a.right,
                fieldHeight: a.height,
                buttonX: b.x,
                buttonHeight: b.height,
                buttonWidth: b.width,
                centerDifference: Math.abs(
                  a.y + a.height / 2 - b.y - b.height / 2,
                ),
              };
            },
          );
          const primary = element.querySelector(
            ".workbench-tool-footer > button:last-child",
          );
          if (!primary) throw new Error("Primary tool action missing");
          return {
            rows,
            pickers,
            actionHeight: primary.getBoundingClientRect().height,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
            height: element.clientHeight,
            scrollHeight: element.scrollHeight,
          };
        });
        expect(layout.rows.length).toBeGreaterThan(0);
        if (layout.rows.length) {
          columns ??= layout.rows[0]!;
          for (const row of layout.rows) {
            expect(Math.abs(row.labelX - columns.labelX)).toBeLessThan(1);
            expect(Math.abs(row.controlX - columns.controlX)).toBeLessThan(1);
            expect(
              Math.abs(row.controlHeight - layout.actionHeight),
            ).toBeLessThan(1);
            expect(row.centerDifference).toBeLessThan(1);
            expect(row.bottomOverflow).toBeLessThanOrEqual(1);
          }
        }
        if (layout.pickers.length) {
          const first = layout.pickers[0]!;
          for (const picker of layout.pickers) {
            expect(Math.abs(picker.buttonX - first.buttonX)).toBeLessThan(1);
            expect(Math.abs(picker.fieldRight - first.fieldRight)).toBeLessThan(
              1,
            );
            expect(
              Math.abs(picker.fieldHeight - picker.buttonHeight),
            ).toBeLessThan(1);
            expect(
              Math.abs(picker.compositeHeight - layout.actionHeight),
            ).toBeLessThan(1);
            expect(
              Math.abs(picker.buttonWidth - picker.buttonHeight),
            ).toBeLessThan(1);
            expect(picker.centerDifference).toBeLessThan(1);
          }
        }
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
        await dialog.screenshot({
          path: testInfo.outputPath(`${name}-${tab}.png`),
        });
      }
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    }
    expect(errors).toEqual([]);
    const unexpected = await page.evaluate(
      () => window.workbenchFixture.unexpectedCommands,
    );
    expect(unexpected).toEqual([]);
  });
}
