import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

for (const tool of ["Workspace", "Connection parameters", "Display options"]) {
  const closures =
    tool === "Display options" ? ["Escape"] : ["Close", "Escape"];
  for (const close of closures) {
    test(`${tool} restores focus after ${close} without an automatic tooltip`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1400, height: 925 });
      await seedWorkbenchFixture(page, { theme: "dark" });
      await page.goto("./#/");
      const trigger = page.getByRole("button", {
        name:
          tool === "Connection parameters" ? /^Connection parameters/ : tool,
        exact: tool !== "Connection parameters",
      });
      await trigger.click();
      const popup =
        tool === "Display options"
          ? page.locator('[data-slot="popover-content"]')
          : page.getByRole("dialog", { name: tool, exact: true });
      await expect(popup).toBeVisible();
      if (close === "Close")
        await popup
          .getByRole("button", { name: "Close view", exact: true })
          .click();
      else {
        await page.mouse.move(700, 500, { steps: 4 });
        await page.keyboard.press("Escape");
      }
      await expect(popup).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.waitForTimeout(1100);
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toHaveCount(0);
      if (tool === "Workspace" && close === "Close")
        await page.screenshot({ path: testInfo.outputPath("after-close.png") });

      await trigger.hover();
      await page.waitForTimeout(200);
      await expect(tooltip).toHaveCount(0);
      await expect(tooltip).toContainText(tool, { timeout: 1500 });
      if (tool === "Workspace" && close === "Close")
        await page.screenshot({ path: testInfo.outputPath("after-hover.png") });
      await page.mouse.move(700, 500, { steps: 4 });
      await expect(tooltip).toHaveCount(0);

      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(trigger).toBeFocused();
      await expect(tooltip).toHaveCount(1);
      await expect(tooltip).toContainText(tool);
    });
  }
}
