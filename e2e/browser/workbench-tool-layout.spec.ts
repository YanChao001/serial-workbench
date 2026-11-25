import { expect, test } from "@playwright/test";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { seedWorkbenchFixture } from "./workbench.fixture";

for (const viewport of [
  { width: 480, height: 540, columns: 1 },
  { width: 1240, height: 760, columns: 2 },
]) {
  test(`transfer dialog shares field sizing and fits at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    const { width, height, columns } = viewport;
    await page.setViewportSize({ width, height });
    await seedWorkbenchFixture(page, {});
    await page.goto("./#/");
    await page
      .getByRole("button", { name: "Open Virtual serial", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Workspace menu", exact: true })
      .press("ArrowDown");
    await page
      .getByRole("menuitem", { name: "File transfer", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "File transfer",
      exact: true,
    });
    await expect(dialog).toBeVisible();

    const basic = dialog.getByRole("tabpanel");
    const firstRow = basic.locator(".workbench-form-row").first();
    const countColumns = (row: Element) =>
      getComputedStyle(row).gridTemplateColumns.split(" ").length;
    expect(await firstRow.evaluate(countColumns)).toBe(columns);

    await dialog.getByRole("tab", { name: "Advanced", exact: true }).click();
    const advanced = dialog.getByRole("tabpanel");
    const field = advanced.locator(".workbench-form-fields > label").first();
    expect(await field.evaluate(countColumns)).toBe(columns);
    const input = field.getByRole("textbox");
    const size = await input.evaluate((node) => ({
      input: node.getBoundingClientRect().height,
      toolbar: Number.parseFloat(
        getComputedStyle(node).getPropertyValue("--app-toolbar-control-size"),
      ),
    }));
    expect(size.input).toBe(size.toolbar);
    expect(
      await dialog.evaluate((element) => {
        const body = element.querySelector(".workbench-dialog-body");
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= window.innerHeight &&
          !!body &&
          body.scrollWidth <= body.clientWidth + 1
        );
      }),
    ).toBe(true);
    await expect(
      dialog.getByRole("button", { name: "Send file", exact: true }),
    ).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath("transfer-dialog.png"),
    });
  });
}

for (const { width, height, language, theme, t } of [
  { width: 410, height: 460, language: "zh", theme: "dark", t: zhCN },
  { width: 1240, height: 760, language: "en", theme: "light", t: en },
] as const) {
  test(`capture tools keep long filenames selectable and task details reachable at ${width}px`, async ({
    page,
  }, info) => {
    const name = `热循环设备-${"TemperatureCalibration-".repeat(7)}Pass3.swbc`;
    await page.setViewportSize({ width, height });
    const reference = {
      hostId: "workbench-gui-host",
      kind: "file",
      id: "capture-target",
      revision: "1",
    } as const;
    await seedWorkbenchFixture(page, {
      language,
      theme,
      captureTarget: {
        reference,
        name,
        length: "0",
        mime: "application/octet-stream",
      },
      fileMetadata: {
        fileRef: reference,
        purpose: "capture_target",
        length: "0",
        fingerprint: "a".repeat(64),
      },
    });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${t["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: t["workbench.closeSession"],
        exact: true,
      }),
    ).toBeEnabled();
    const menu = page.getByRole("button", {
      name: t["workbench.tools.more"],
      exact: true,
    });
    const title = t["workbench.tools.captureTools"];
    const direct = page.getByRole("button", { name: title, exact: true });
    const opener = (await direct.isVisible()) ? direct : menu;
    if (opener === direct) await direct.click();
    else {
      await menu.press("ArrowDown");
      await page.getByRole("menuitem", { name: title, exact: true }).click();
    }
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    const browse = dialog.getByRole("button", {
      name: t["workbench.tools.selectTarget"],
      exact: true,
    });
    const filename = dialog.getByRole("textbox", {
      name: t["workbench.tools.recordingFile"],
      exact: true,
    });
    await expect(filename).toHaveAttribute(
      "placeholder",
      t["workbench.tools.selectTarget"],
    );
    await browse.click();
    await expect(filename).toHaveValue(name);
    await expect(browse).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(filename).toBeFocused();
    await filename.press("ControlOrMeta+a");
    expect(
      await filename.evaluate((node) => {
        if (!(node instanceof HTMLInputElement))
          throw new Error("Missing filename field");
        return node.value.slice(
          node.selectionStart ?? 0,
          node.selectionEnd ?? 0,
        );
      }),
    ).toBe(name);
    const writeMode = dialog.getByRole("combobox", {
      name: t["workbench.tools.writeMode"],
      exact: true,
    });
    expect(
      await filename.evaluate(
        (node) => node.parentElement?.getBoundingClientRect().height,
      ),
    ).toBe((await writeMode.boundingBox())?.height);
    const start = dialog.getByRole("button", {
      name: t["workbench.tools.startCapture"],
      exact: true,
    });
    await expect(start).toBeInViewport();
    expect(
      await dialog
        .locator(".workbench-dialog-body")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await writeMode.focus();
    await dialog.screenshot({ path: info.outputPath("capture-file.png") });
    await start.click();
    await expect(
      dialog.getByText(t["workbench.operation.succeeded"], { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addStyleTag({
      content: `@keyframes test-workspace-menu-exit {
        from { opacity: 0.9; } to { opacity: 0; }
      }
      .workbench-workspace-menu[data-state="closed"] {
        animation: test-workspace-menu-exit 700ms paused !important;
      }`,
    });
    const closingMenu = page.locator(
      '.workbench-workspace-menu[data-state="closed"]',
    );
    await menu.press("ArrowDown");
    const taskTitle = t["workbench.tasks"];
    await page.getByRole("menuitem", { name: taskTitle, exact: true }).click();
    const tasks = page.getByRole("dialog", { name: taskTitle, exact: true });
    const header = tasks.locator(".workbench-operation-heading").filter({
      hasText: t["workbench.tools.startCapture"],
    });
    await expect(header).toBeVisible();
    const details = header.getByRole("button", {
      name: t["common.details"],
      exact: true,
    });
    const [taskName, state, evidence] = await Promise.all([
      header
        .getByText(t["workbench.tools.startCapture"], { exact: true })
        .boundingBox(),
      header
        .getByText(t["workbench.operation.succeeded"], { exact: true })
        .boundingBox(),
      details.boundingBox(),
    ]);
    if (!taskName || !state || !evidence)
      throw new Error("Missing task geometry");
    expect(evidence.x).toBeGreaterThan(taskName.x + taskName.width);
    if (width < 500)
      expect(state.y).toBeGreaterThanOrEqual(taskName.y + taskName.height);
    else expect(Math.abs(state.y - taskName.y)).toBeLessThan(2);
    await details.focus();
    await page.keyboard.press("Enter");
    const receipt = page.getByRole("textbox", {
      name: t["common.details"],
      exact: true,
    });
    await expect(closingMenu).toHaveCount(1);
    await expect(receipt).toHaveValue(/fixture-capture-start/);
    await expect(receipt).toBeFocused();
    await closingMenu.evaluate((node) => {
      const animation = node
        .getAnimations()
        .find(
          (item) =>
            item instanceof CSSAnimation &&
            item.animationName === "test-workspace-menu-exit",
        );
      if (!animation) throw new Error("Expected a paused menu exit animation");
      animation.finish();
    });
    await expect(closingMenu).toHaveCount(0);
    await expect(receipt).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(receipt).toBeHidden();
    await expect(details).toBeFocused();
    await tasks.screenshot({ path: info.outputPath("capture-task.png") });
    await page.keyboard.press("Escape");
    await expect(tasks).toBeHidden();
    await expect(menu).toBeFocused();
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  });
}
