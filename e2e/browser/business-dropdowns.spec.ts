/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

// 生产浏览器控件使用明确的 IPC 夹具；不代替 Host/硬件验收，保留原有超时预算。
async function openTool(page: Page, name: string) {
  const menu = page.getByRole("button", {
    name: /Workspace menu|工作区菜单/,
    exact: true,
  });
  await expect(menu).toBeVisible();
  const direct = page.getByRole("button", { name, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await menu.focus();
    await menu.press("ArrowDown");
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  // Radix Select 打开 portal 时会暂时隐藏所属模态框的可访问树；核对名称后保留框体定位。
  const frame = page.locator('[data-slot="dialog-content"]');
  await expect(frame).toHaveCount(1);
  return frame;
}

async function popupAppearance(popup: Locator) {
  const appearance = await popup.evaluate((element) => {
    const style = getComputedStyle(element);
    // 在真实浏览器中解析语义 token；隐藏的固定探针不占布局，截图前移除。
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;visibility:hidden;background:var(--surface-popover);color:var(--popover-foreground)";
    element.append(probe);
    const reference = getComputedStyle(probe);
    const result = {
      background: style.backgroundColor,
      foreground: style.color,
      border: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      radius: style.borderTopLeftRadius,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      expectedBackground: reference.backgroundColor,
      expectedForeground: reference.color,
    };
    probe.remove();
    return result;
  });
  expect(appearance.background).toBe(appearance.expectedBackground);
  expect(appearance.foreground).toBe(appearance.expectedForeground);
  expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(appearance.border).toBe("1px");
  expect(appearance.borderStyle).toBe("solid");
  return appearance;
}

async function selectOption(
  page: Page,
  dialog: Locator,
  label: string,
  option: string,
  screenshot?: string,
) {
  const control = dialog.getByRole("combobox", { name: label, exact: true });
  await expect(control).toBeEnabled();
  await expect(control).toHaveJSProperty("tagName", "BUTTON");
  await expect(control).toHaveAttribute("data-slot", "select-trigger");
  const frame = await dialog.boundingBox();
  await control.click();
  const popup = page.getByRole("listbox");
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("data-slot", "select-content");
  await expect(popup).toHaveClass(/options-select-content/);
  const appearance = await popupAppearance(popup);
  expect(await dialog.boundingBox()).toEqual(frame);
  await popup.getByRole("option", { name: option, exact: true }).click();
  await expect(popup).toBeHidden();
  await expect(control).toHaveText(option);
  await control.click();
  await expect(popup).toBeVisible();
  await expect(
    popup.getByRole("option", { name: option, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  if (screenshot)
    await page.screenshot({ path: screenshot, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(control).toBeFocused();
  await expect(control).toHaveText(option);
  expect(await dialog.boundingBox()).toEqual(frame);
  return appearance;
}

async function workbenchRectangles(page: Page) {
  return page.evaluate(() =>
    [
      ".workbench-stream-log",
      ".workbench-draft-frame",
      ".workbench-send-button",
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing layout region ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

for (const sample of [
  { language: "en", theme: "light", width: 1120, height: 744 },
  { language: "zh", theme: "dark", width: 880, height: 600 },
] as const) {
  test(`editable baud presets and themed configuration choices (${sample.language}/${sample.theme})`, async ({
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
      sidebarCollapsed: true,
    });
    await page.goto("./#/");
    await expect(page.locator("html")).toHaveCSS("color-scheme", sample.theme);
    await expect(
      page.getByRole("button", {
        name: /Open Virtual serial|打开 Virtual serial/,
        exact: true,
      }),
    ).toBeEnabled();
    const rectangles = await workbenchRectangles(page);
    const name = t("workbench.tools.parameters");
    const dialog = await openTool(page, name);
    const frame = await dialog.boundingBox();
    const baud = dialog.getByRole("combobox", {
      name: t("workbench.tools.baudRate"),
      exact: true,
    });
    await expect(baud).toBeEditable();
    await expect(baud).toHaveValue("9600");
    await expect(
      dialog.locator('select:not([aria-hidden="true"]),datalist,input[list]'),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", {
        name: t("workbench.tools.baudPresets"),
        exact: true,
      })
      .click();
    const presets = page.getByRole("listbox", {
      name: t("workbench.tools.baudPresets"),
      exact: true,
    });
    await expect(presets).toBeVisible();
    await expect(presets).toHaveAttribute("data-slot", "popover-content");
    await expect(presets.getByRole("option")).toHaveText([
      "1200",
      "2400",
      "4800",
      "9600",
      "19200",
      "38400",
      "57600",
      "115200",
      "230400",
      "460800",
      "921600",
    ]);
    const baudAppearance = await popupAppearance(presets);
    expect(await dialog.boundingBox()).toEqual(frame);
    expect(await workbenchRectangles(page)).toEqual(rectangles);
    await page.screenshot({
      path: info.outputPath(
        `baud-presets-${sample.language}-${sample.theme}.png`,
      ),
      animations: "disabled",
    });
    await expect(baud).toBeFocused();
    for (let index = 0; index < 4; index++) await baud.press("ArrowDown");
    const activeId = await baud.getAttribute("aria-activedescendant");
    if (!activeId)
      throw new Error("Baud keyboard selection has no active option");
    await expect(
      presets.getByRole("option", { name: "115200", exact: true }),
    ).toHaveAttribute("id", activeId);
    await baud.press("Enter");
    await expect(presets).toBeHidden();
    await expect(baud).toHaveValue("115200");
    await expect(baud).toBeFocused();
    await baud.fill("31250");
    await baud.press("Tab");
    await expect(baud).toHaveValue("31250");
    await expect(baud).toHaveAttribute("aria-invalid", "false");
    await expect(
      dialog.getByRole("button", {
        name: t("workbench.tools.applyConfiguration"),
        exact: true,
      }),
    ).toHaveCount(0);

    const choices = [
      [t("workbench.tools.dataBits"), "7"],
      [t("workbench.tools.parity"), t("workbench.tools.even")],
      [t("workbench.tools.stopBits"), t("workbench.tools.two")],
      [t("workbench.tools.flowControl"), t("workbench.tools.rtsCts")],
    ] as const;
    const appearances = [];
    for (const [label, option] of choices) {
      const appearance = await selectOption(page, dialog, label, option);
      expect(appearance.background).toBe(baudAppearance.background);
      expect(appearance.foreground).toBe(baudAppearance.foreground);
      appearances.push(appearance);
    }
    for (const appearance of appearances)
      expect(appearance).toEqual(appearances[0]);
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    const parameters = page.getByRole("button", { name, exact: true });
    await parameters.focus();
    await expect(parameters).toHaveAccessibleDescription(/31250 \/ 7E2/);
    const reopened = await openTool(page, name);
    await expect(
      reopened.getByRole("combobox", {
        name: t("workbench.tools.baudRate"),
        exact: true,
      }),
    ).toHaveValue("31250");
    for (const [label, option] of choices)
      await expect(
        reopened.getByRole("combobox", { name: label, exact: true }),
      ).toHaveText(option);
    expect(await workbenchRectangles(page)).toEqual(rectangles);
    await info.attach("dropdown-appearance", {
      body: JSON.stringify({ baudAppearance, appearances }, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });

  test(`session and capture choices share popup styling and keep their dialog open on Escape (${sample.language}/${sample.theme})`, async ({
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
      sidebarCollapsed: true,
    });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: /Open Virtual serial|打开 Virtual serial/,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: t("workbench.closeSession"),
        exact: true,
      }),
    ).toBeEnabled();
    const rectangles = await workbenchRectangles(page);
    const parameters = await openTool(page, t("workbench.tools.parameters"));
    await expect(
      parameters.locator('select:not([aria-hidden="true"]),datalist'),
    ).toHaveCount(0);
    const purgeDirection = await selectOption(
      page,
      parameters,
      t("workbench.tools.purgeDirection"),
      t("workbench.tools.tx"),
    );
    const purgeScope = await selectOption(
      page,
      parameters,
      t("workbench.tools.purgeScope"),
      t("workbench.tools.driver"),
    );
    expect(purgeScope).toEqual(purgeDirection);
    await parameters.press("Escape");
    await expect(parameters).toBeHidden();
    const capture = await openTool(page, t("workbench.tools.captureTools"));
    await expect(
      capture.locator('select:not([aria-hidden="true"]),datalist'),
    ).toHaveCount(0);
    const writeMode = await selectOption(
      page,
      capture,
      t("workbench.tools.writeMode"),
      t("workbench.tools.append"),
      info.outputPath(`capture-mode-${sample.language}-${sample.theme}.png`),
    );
    expect(writeMode).toEqual(purgeDirection);
    await capture
      .getByRole("tab", {
        name: t("workbench.tools.playback"),
        exact: true,
      })
      .click();
    const replayMode = await selectOption(
      page,
      capture,
      t("workbench.tools.replayMode"),
      t("workbench.tools.fastest"),
    );
    expect(replayMode).toEqual(purgeDirection);
    expect(await workbenchRectangles(page)).toEqual(rectangles);
    await info.attach("dropdown-appearance", {
      body: JSON.stringify(
        { purgeDirection, purgeScope, writeMode, replayMode },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}
