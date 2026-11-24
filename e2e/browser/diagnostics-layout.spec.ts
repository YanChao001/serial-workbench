/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { seedWorkbenchFixture } from "./workbench.fixture";

const samples = [
  { language: "zh", theme: "dark", width: 410, height: 460, messages: zhCN },
  { language: "en", theme: "light", width: 1240, height: 760, messages: en },
] as const;

for (const { language, theme, width, height, messages } of samples) {
  test(`diagnostics keep actions and a long report usable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await seedWorkbenchFixture(page, {
      currentPage: "settings",
      language,
      theme,
      sidebarCollapsed: true,
      diagnosticLogs:
        "serial diagnostic ".repeat(30) + "X".repeat(1300) + "\n".repeat(80),
    });
    await page.goto("./#/settings?focus=recovery");

    const panel = page.getByRole("region", {
      name: messages["diagnostics.preview"],
    });
    const title = panel.getByRole("heading", {
      name: messages["diagnostics.preview"],
    });
    const copy = panel.getByRole("button", {
      name: messages["diagnostics.copy"],
    });
    const save = panel.getByRole("button", {
      name: messages["diagnostics.save"],
    });
    const refresh = panel.getByRole("button", {
      name: messages["diagnostics.refresh"],
    });
    await expect(refresh).toBeEnabled();
    await expect(panel.getByText(messages["diagnostics.logs"])).toBeVisible();

    const geometry = await Promise.all([
      title.boundingBox(),
      copy.boundingBox(),
      save.boundingBox(),
      refresh.boundingBox(),
    ]);
    const [heading, copyBox, saveBox, refreshBox] = geometry;
    if (!heading || !copyBox || !saveBox || !refreshBox)
      throw new Error("Missing diagnostics geometry");
    if (width < 500) {
      expect(copyBox.y).toBeGreaterThan(heading.y + heading.height);
    } else {
      expect(Math.abs(copyBox.y - heading.y)).toBeLessThan(6);
      expect(copyBox.x).toBeGreaterThanOrEqual(heading.x + heading.width);
    }
    for (const action of [copyBox, saveBox, refreshBox]) {
      expect(action.height).toBeGreaterThanOrEqual(32);
      expect(action.x + action.width).toBeLessThanOrEqual(width);
    }

    const disclosure = panel
      .locator("summary")
      .filter({ hasText: messages["diagnostics.details"] });
    await disclosure.focus();
    await disclosure.press("Enter");
    await disclosure.press("Tab");
    const preview = panel.getByTestId("diagnostics-report");
    await expect(preview).toBeFocused();
    expect(
      await preview.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await preview.press("PageDown");
    await expect
      .poll(() => preview.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await save.focus();
    await save.press("Enter");
    await expect(save).toBeFocused();
    await expect(save).toBeEnabled();
    await expect(preview).toBeVisible();
    await expect(
      page.getByText(messages["diagnostics.saved"], { exact: true }),
    ).toHaveCount(0);
    await panel.screenshot({
      path: info.outputPath(`diagnostics-${width}.png`),
    });
  });
}
