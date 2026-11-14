/// <reference lib="dom" />
import { expect, test, type Locator } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import type { WorkspaceDocument } from "@serial-workbench/contracts";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import { validateSerialConfiguration } from "../../packages/contracts/src/generated/validators.mjs";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

const generatedConfiguration: unknown = defaults.serialConfiguration;
if (!validateSerialConfiguration(generatedConfiguration))
  throw new Error("Invalid generated serial configuration");
const serialConfiguration = generatedConfiguration;

async function focusedControl(control: Locator, appearance: Locator = control) {
  await control.evaluate(async (element) => {
    const dialog = element.closest('[role="dialog"]');
    if (dialog)
      await Promise.all(
        dialog
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
  });
  const before = await appearance.boundingBox();
  const contentBefore = await control.boundingBox();
  await control.focus();
  const visible = await control.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
    return element.matches(":focus-visible");
  });
  const result = await appearance.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      borderWidth: style.borderLeftWidth,
      borderColor: style.borderLeftColor,
      borderStyle: style.borderLeftStyle,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      shadow: style.boxShadow,
      focusWithin: element.matches(":focus-within"),
    };
  });
  expect(result.width).toBe(before?.width);
  expect(result.height).toBe(before?.height);
  const contentAfter = await control.boundingBox();
  expect(contentAfter?.width).toBe(contentBefore?.width);
  expect(contentAfter?.height).toBe(contentBefore?.height);
  expect(visible).toBe(true);
  return result;
}

function expectNoHalo(shadow: string) {
  expect(shadow === "none" || shadow.endsWith(" 0px 0px 0px 0px")).toBe(true);
}

for (const sample of [
  { language: "zh", theme: "dark", width: 1399, height: 924, intensity: 0 },
  { language: "zh", theme: "dark", width: 880, height: 600, intensity: 90 },
  { language: "en", theme: "light", width: 1120, height: 744, intensity: 90 },
  { language: "en", theme: "light", width: 880, height: 600, intensity: 0 },
] as const) {
  test(`compact spacing and distinct device selection (${sample.language}/${sample.theme}/${sample.intensity}/${sample.width})`, async ({
    page,
  }, info) => {
    const dictionary = sample.language === "zh" ? zhCN : en;
    const t = (key: keyof typeof en) => dictionary[key];
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    const workspace: WorkspaceDocument = {
      ...defaults.workspace,
      bindings: [
        {
          bindingId: "spacing-device",
          hostId: "workbench-gui-host",
          deviceId: "device",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          configuration: serialConfiguration,
          reconnect: { enabled: false, maxAttempts: "3", maxDelayMs: "1000" },
        },
      ],
      views: [t("workbench.draft"), "virtual:echo"].map((name, index) => ({
        id: `spacing-view-${index}`,
        name,
        color: "#84CC16",
        icon: "terminal",
        pinned: false,
        bindingId: "spacing-device",
        receiveMode: "text",
        sendMode: "text",
      })),
    };
    await seedWorkbenchFixture(page, {
      language: sample.language,
      theme: sample.theme,
      sidebarCollapsed: true,
      backgroundIntensity: sample.intensity,
      sharedSettings: { accent: "lime" },
      workspace,
    });
    await page.goto("./#/");
    const draft = page.getByRole("textbox", {
      name: t("workbench.draft"),
      exact: true,
    });
    await expect(draft).toBeEditable();
    await draft.fill(
      "这是发送草稿，保持边缘与控件对齐。A longer local draft for spacing.",
    );
    const draftFrame = page.locator(".workbench-draft-frame");
    const draftFocus = await focusedControl(draft, draftFrame);
    expect(draftFocus.borderWidth).toBe("1px");
    expect(draftFocus.outlineStyle).toBe("none");
    expect(draftFocus.focusWithin).toBe(true);
    expectNoHalo(draftFocus.shadow);
    const deviceSelector = page.locator(".workbench-device-select");
    const selectorFocus = await focusedControl(deviceSelector);
    expect(selectorFocus.borderWidth).toBe("1px");
    expect(selectorFocus.outlineStyle).toBe("none");
    expectNoHalo(selectorFocus.shadow);
    await draft.focus();
    const geometry = await page.locator(".workbench").evaluate((root) => {
      function rect(selector: string) {
        const element =
          root.querySelector(selector) ?? document.querySelector(selector);
        if (!element) throw new Error(`Missing layout region ${selector}`);
        const { x, y, width, height, right, bottom } =
          element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x,
          y,
          width,
          height,
          right,
          bottom,
          borderTop: parseFloat(style.borderTopWidth),
          borderBottom: parseFloat(style.borderBottomWidth),
        };
      }
      return {
        panel: rect(".workbench-device-select"),
        connection: rect(".workbench-connection"),
        receiveToolbar: rect(".workbench-receive-toolbar"),
        composeToolbar: rect(".workbench-compose-toolbar"),
        titlebar: rect(".app-title-bar"),
        titleAction: rect(".app-title-icon-button"),
        receiveEncoding: rect(
          ".workbench-receive-toolbar .workbench-encoding-select",
        ),
        sendEncoding: rect(
          ".workbench-compose-toolbar .workbench-encoding-select",
        ),
        editor: rect(".workbench-editor"),
        receive: rect(".workbench-receive-frame"),
        send: rect(".workbench-send"),
        input: rect(".workbench-draft-frame"),
        text: rect(".workbench-draft"),
        byteLabel: rect(".workbench-draft-bytes"),
        button: rect(".workbench-send-button"),
        tablist: rect(".workbench-tablist"),
        firstTab: rect('.workbench-tablist [role="tab"]'),
        mainWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
      };
    });
    expect(geometry.panel.width).toBeLessThanOrEqual(128);
    for (const encoding of [geometry.receiveEncoding, geometry.sendEncoding])
      expect(encoding.width).toBeLessThanOrEqual(112);
    for (const bar of [
      geometry.connection,
      geometry.receiveToolbar,
      geometry.composeToolbar,
    ])
      expect(bar.height).toBe(geometry.titlebar.height);
    for (const [bar, control] of [
      [geometry.titlebar, geometry.titleAction],
      [geometry.connection, geometry.panel],
      [geometry.receiveToolbar, geometry.receiveEncoding],
      [geometry.composeToolbar, geometry.sendEncoding],
    ] as const) {
      expect(control.height).toBe(geometry.panel.height);
      const available = bar.height - bar.borderTop - bar.borderBottom;
      expect(
        Math.abs(
          control.y - bar.y - bar.borderTop - (available - control.height) / 2,
        ),
      ).toBeLessThanOrEqual(0.5);
    }
    expect(geometry.button.width).toBeGreaterThanOrEqual(47);
    expect(Math.abs(geometry.button.y - geometry.input.y)).toBeLessThan(1);
    expect(
      Math.abs(geometry.button.height - geometry.input.height),
    ).toBeLessThan(1);
    const leftInset = geometry.receive.x - geometry.editor.x;
    const rightInset = geometry.editor.right - geometry.receive.right;
    const bottomInset = geometry.editor.bottom - geometry.receive.bottom;
    expect(leftInset).toBeGreaterThanOrEqual(7);
    expect(Math.abs(leftInset - rightInset)).toBeLessThan(1);
    const verticalInset = geometry.panel.y - geometry.connection.y;
    const verticalGaps = [
      geometry.connection.bottom -
        geometry.connection.borderBottom -
        geometry.panel.bottom,
      geometry.receiveEncoding.y - geometry.receiveToolbar.y,
      geometry.receive.y - geometry.receiveEncoding.bottom,
      bottomInset,
      geometry.sendEncoding.y - geometry.composeToolbar.y,
      geometry.input.y - geometry.sendEncoding.bottom,
      geometry.send.bottom - geometry.input.bottom,
    ];
    expect(verticalInset).toBeGreaterThan(0);
    for (const gap of verticalGaps)
      expect(Math.abs(gap - verticalInset)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.input.x - geometry.receive.x)).toBeLessThan(1);
    expect(
      Math.abs(geometry.button.right - geometry.receive.right),
    ).toBeLessThan(1);
    expect(geometry.firstTab.x - geometry.tablist.x).toBeGreaterThanOrEqual(1);
    expect(geometry.firstTab.y - geometry.tablist.y).toBeGreaterThanOrEqual(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.mainWidth + 1);
    expect(geometry.text.bottom).toBeLessThanOrEqual(geometry.byteLabel.y);
    expect(geometry.byteLabel.x).toBeGreaterThan(
      geometry.input.x + geometry.input.width / 2,
    );
    expect(geometry.byteLabel.right).toBeLessThanOrEqual(
      geometry.input.right - 12,
    );
    expect(geometry.byteLabel.bottom).toBeLessThanOrEqual(
      geometry.input.bottom,
    );
    const byteLabel = page.locator(".workbench-draft-bytes");
    const labelSemantics = await byteLabel.evaluate((label) => {
      const frame = label.closest(".workbench-draft-frame")!;
      const box = frame.getBoundingClientRect();
      return {
        tag: label.tagName,
        role: label.getAttribute("role"),
        tabindex: label.getAttribute("tabindex"),
        pointerEvents: getComputedStyle(label).pointerEvents,
        interactiveAncestor: Boolean(
          label.closest('button, a, [role="button"]'),
        ),
        gripAccessible:
          document.elementFromPoint(box.right - 3, box.bottom - 3) === frame,
      };
    });
    expect(labelSemantics).toEqual({
      tag: "SPAN",
      role: "note",
      tabindex: null,
      pointerEvents: "none",
      interactiveAncestor: false,
      gripAccessible: true,
    });
    const originalDraft = await draft.inputValue();
    await draft.fill(
      Array.from(
        { length: 8 },
        (_, index) => `${index + 1}. ${originalDraft}`,
      ).join("\n"),
    );
    const scrolled = await draft.evaluate((element) => {
      if (!(element instanceof HTMLTextAreaElement))
        throw new Error("Send draft is not an editable text area");
      element.scrollTop = element.scrollHeight;
      return {
        top: element.scrollTop,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        bottom: element.getBoundingClientRect().bottom,
      };
    });
    expect(scrolled.top).toBeGreaterThan(0);
    expect(scrolled.scrollHeight).toBeGreaterThan(scrolled.height);
    expect(scrolled.bottom).toBeLessThanOrEqual(
      (await byteLabel.boundingBox())!.y,
    );
    const stableFrame = await draftFrame.boundingBox();
    expect(stableFrame?.width).toBe(geometry.input.width);
    expect(stableFrame?.height).toBe(geometry.input.height);
    await draft.fill(originalDraft);
    const sidebarColors = await page
      .locator("#app-sidebar")
      .evaluate((sidebar) => {
        const root = document.documentElement;
        const original = root.dataset.accent;
        const before = getComputedStyle(sidebar).backgroundColor;
        root.dataset.accent = "rose";
        const after = getComputedStyle(sidebar).backgroundColor;
        root.dataset.accent = original;
        return { before, after };
      });
    expect(sidebarColors.after).toBe(sidebarColors.before);
    await page.screenshot({ path: info.outputPath("workbench-spacing.png") });
    const tool = page.getByRole("button", {
      name: t("workbench.tools.devices"),
      exact: true,
    });
    if (await tool.isVisible()) await tool.click();
    else {
      const menu = page.getByRole("button", {
        name: t("workbench.tools.more"),
        exact: true,
      });
      await menu.focus();
      await menu.press("ArrowDown");
      await page
        .getByRole("menuitem", {
          name: t("workbench.tools.devices"),
          exact: true,
        })
        .click();
    }
    const dialog = page.getByRole("dialog", {
      name: t("workbench.tools.devices"),
      exact: true,
    });
    const device = dialog.getByRole("button", {
      name: "Virtual serial",
      exact: true,
    });
    await expect(device).toHaveAttribute("aria-pressed", "true");
    const selection = await device.evaluate((element) => {
      const style = getComputedStyle(element);
      const marker = getComputedStyle(element, "::before");
      return {
        marker: marker.content,
        markerWidth: parseFloat(marker.width),
        markerTop: parseFloat(marker.top),
        markerBottom: parseFloat(marker.bottom),
        height: element.getBoundingClientRect().height,
        selectedBackground: style.backgroundColor,
        parentBackground: getComputedStyle(element.parentElement!)
          .backgroundColor,
        border: style.borderInlineStartColor,
        background: style.backgroundColor,
      };
    });
    expect(selection.marker).not.toBe("none");
    expect(selection.markerWidth).toBeGreaterThanOrEqual(2);
    expect(
      selection.height - selection.markerTop - selection.markerBottom,
    ).toBeGreaterThanOrEqual(8);
    expect(selection.selectedBackground).not.toBe(selection.parentBackground);
    expect(selection.border).not.toBe(selection.background);
    await device.press("Tab");
    const deviceFocus = await focusedControl(device);
    expect(deviceFocus.outlineWidth).toBe("1px");
    expect(deviceFocus.outlineStyle).toBe("solid");
    expectNoHalo(deviceFocus.shadow);
    await dialog.screenshot({ path: info.outputPath("device-selection.png") });
    if (sample.width === 1399) {
      await page.keyboard.press("Escape");
      const parameters = page
        .locator(".workbench-connection")
        .getByRole("button", {
          name: new RegExp(`^${t("workbench.tools.parameters")}`),
        });
      await parameters.click();
      const parameterDialog = page.getByRole("dialog", {
        name: t("workbench.tools.parameters"),
        exact: true,
      });
      const baud = parameterDialog.getByRole("combobox", {
        name: t("workbench.tools.baudRate"),
        exact: true,
      });
      const value = await baud.inputValue();
      const normalFocus = await focusedControl(baud);
      expect(normalFocus.borderWidth).toBe("1px");
      expectNoHalo(normalFocus.shadow);
      await baud.fill("0");
      await expect(baud).toHaveAttribute("aria-invalid", "true");
      const invalidFocus = await focusedControl(baud);
      expect(invalidFocus.borderWidth).toBe("1px");
      expect(invalidFocus.borderColor).not.toBe(normalFocus.borderColor);
      expectNoHalo(invalidFocus.shadow);
      await parameterDialog.screenshot({
        path: info.outputPath("input-focus-invalid.png"),
      });
      await page.emulateMedia({ forcedColors: "active" });
      const forcedFocus = await focusedControl(baud);
      expect(forcedFocus.borderWidth).toBe("1px");
      expect(forcedFocus.borderStyle).toBe("dashed");
      expectNoHalo(forcedFocus.shadow);
      await parameterDialog.screenshot({
        path: info.outputPath("input-focus-forced-colors.png"),
      });
      await baud.fill(value);
    }
    expect(failures).toEqual([]);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}
