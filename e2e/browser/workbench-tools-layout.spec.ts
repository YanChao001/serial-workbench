/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

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
      Math.abs(importPicker.buttonHeight - workspaceAction!.height),
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
  await expect(
    page.getByRole("button", { name: "Open Virtual serial", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
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
              const input = label.querySelector(
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
              Math.abs(picker.buttonHeight - layout.actionHeight),
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
