/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedWorkbenchFixture } from "./workbench.fixture";

const records = new WeakMap<
  Page,
  { errors: string[]; console: { type: string; text: string }[] }
>();
test.beforeEach(async ({ page }) => {
  const record = {
    errors: [] as string[],
    console: [] as { type: string; text: string }[],
  };
  records.set(page, record);
  page.on("pageerror", (e) => record.errors.push(e.message));
  page.on("console", (m) => {
    record.console.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") record.errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.url().includes("/assets/") && r.status() >= 400)
      record.errors.push(`${r.status()} ${r.url()}`);
  });
});
test.afterEach(async ({ page }, info) => {
  const fixture = await page.evaluate(() => window.workbenchFixture);
  await writeFile(
    info.outputPath("runtime-and-ipc.json"),
    JSON.stringify({ ...records.get(page), fixture }, null, 2),
  );
  expect(records.get(page)?.errors).toEqual([]);
  expect(fixture.unexpectedCommands).toEqual([]);
});
for (const language of ["en", "zh"] as const)
  test(`platform guidance uses native keyboard disclosure and explicit refresh in ${language}`, async ({
    page,
  }, info) => {
    const text =
      language === "en"
        ? {
            open: "Open Virtual serial",
            menu: "Workspace menu",
            tool: "Troubleshooting",
            refresh: "Refresh",
            manager: "Device Manager",
            manual: "manual checks",
            after: "After completing the system steps",
          }
        : {
            open: "\u6253\u5f00 Virtual serial",
            menu: "\u5de5\u4f5c\u533a\u83dc\u5355",
            tool: "\u6545\u969c\u5b9a\u4f4d",
            refresh: "\u5237\u65b0",
            manager: "\u8bbe\u5907\u7ba1\u7406\u5668",
            manual: "\u624b\u52a8\u68c0\u67e5",
            after: "\u5b8c\u6210\u7cfb\u7edf\u64cd\u4f5c\u540e",
          };
    await page.setViewportSize({ width: 880, height: 600 });
    await seedWorkbenchFixture(page, {
      language,
      theme: language === "en" ? "light" : "dark",
    });
    await page.goto("./#/");
    await page.getByRole("button", { name: text.open, exact: true }).click();
    // trustedConnect explicitly refreshes its catalog/devices after acquiring permissions.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.hostQueries.filter(
              (q) => q === "device.list",
            ).length,
        ),
      )
      .toBe(2);
    const baseline = await page.evaluate(
      () =>
        window.workbenchFixture.hostQueries.filter((q) => q === "device.list")
          .length,
    );
    const menu = page.getByRole("button", { name: text.menu, exact: true });
    await menu.focus();
    await menu.press("Enter");
    const item = page.getByRole("menuitem", { name: text.tool, exact: true });
    await item.focus();
    await item.press("Enter");
    const dialog = page.getByRole("dialog", { name: text.tool, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(text.manual);
    const platforms = ["Windows", "macOS", "Linux"];
    const summaries = platforms.map((name) =>
      dialog.locator("summary").filter({ hasText: new RegExp(`^${name}$`) }),
    );
    await dialog.focus();
    await page.keyboard.press("Tab");
    await expect(summaries[0]!).toBeFocused();
    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i]!;
      await expect(summary.locator("..")).not.toHaveAttribute("open", "");
      await summary.press(i === 1 ? "Space" : "Enter");
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      await expect(summary.locator("..").locator("ol > li")).toHaveCount(
        i === 1 ? 4 : 3,
      );
      if (i < summaries.length - 1) {
        await summary.press("Tab");
        await expect(summaries[i + 1]!).toBeFocused();
      }
    }
    await expect(summaries[0]!.locator("..")).toContainText(text.manager);
    await expect(summaries[1]!.locator("..")).toContainText("Apple Silicon");
    await expect(summaries[1]!.locator("..")).toContainText("/dev/cu.*");
    await expect(summaries[2]!.locator("..")).toContainText("ls -l");
    await expect(summaries[2]!.locator("..")).toContainText("id -nG");
    await expect(summaries[2]!.locator("..")).toContainText("dialout");
    await expect(dialog.locator("a")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          window.workbenchFixture.hostQueries.filter((q) => q === "device.list")
            .length,
      ),
    ).toBe(baseline);
    await summaries[0]!.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`platform-guidance-${language}-top-880.png`),
    });
    await summaries[2]!.focus();
    await summaries[2]!.press("End");
    await expect
      .poll(() => dialog.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    expect(await dialog.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(
      true,
    );
    await writeFile(
      info.outputPath("disclosure-scroll-geometry.json"),
      JSON.stringify(
        await dialog.evaluate((e) => ({
          scrollTop: e.scrollTop,
          scrollHeight: e.scrollHeight,
          clientHeight: e.clientHeight,
          pageScroll: scrollY,
          pageWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        })),
        null,
        2,
      ),
    );
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(dialog).toContainText(text.after);
    const refresh = dialog.getByRole("button", {
      name: text.refresh,
      exact: true,
    });
    await refresh.focus();
    await refresh.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.hostQueries.filter(
              (q) => q === "device.list",
            ).length,
        ),
      )
      .toBeGreaterThan(baseline);
    await expect(dialog).toBeVisible();
    await summaries[2]!.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`platform-guidance-${language}-880.png`),
    });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    await writeFile(
      info.outputPath("accessibility.json"),
      JSON.stringify(axe, null, 2),
    );
    expect(axe.violations).toEqual([]);
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();
  });
