/// <reference lib="dom" />
import { seedBrowserSettings } from "./browser-settings.fixture";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("sidebar icons remain aligned through collapse and expansion without remounting", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await seedBrowserSettings(page, {
    motion: "full",
    theme: "light",
    background: "plain",
    sidebarCollapsed: false,
  });
  await page.goto("./#/");
  await expect(page.locator("#app-sidebar")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  const measurement = await page.evaluate(async () => {
    const sidebar = document.querySelector("#app-sidebar");
    const links = sidebar?.querySelectorAll("a.app-sidebar-link");
    if (!sidebar || !links || links.length < 2)
      throw new Error("Sidebar navigation unavailable");
    const targets = [links[0]!, links[links.length - 1]!];
    const icons = targets.map((link) => link.querySelector("svg"));
    if (icons.some((icon) => !icon))
      throw new Error("Sidebar icons unavailable");
    const frames: Array<{
      collapsed: string | null;
      x: number[];
      padding: string[];
      parentPadding: string[];
      opacity: string[];
      sameNodes: boolean;
    }> = [];
    for (let frame = 0; frame < 90; frame++) {
      if (frame === 5 || frame === 45) {
        const toggle = sidebar.querySelector<HTMLButtonElement>(
          "button[aria-controls='app-sidebar-navigation']",
        );
        if (!toggle) throw new Error("Sidebar control unavailable");
        toggle.click();
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      frames.push({
        collapsed: sidebar.getAttribute("data-collapsed"),
        x: targets.map(
          (link) => link.querySelector("svg")!.getBoundingClientRect().x,
        ),
        padding: targets.map(
          (link) => getComputedStyle(link).paddingInlineStart,
        ),
        parentPadding: targets.map(
          (link) =>
            getComputedStyle(link.closest("nav, .app-sidebar-tools")!)
              .paddingInlineStart,
        ),
        opacity: targets.map(
          (link) => getComputedStyle(link.querySelector("svg")!).opacity,
        ),
        sameNodes: targets.every(
          (link, index) => link.querySelector("svg") === icons[index],
        ),
      });
    }
    return frames;
  });
  const framesPath = testInfo.outputPath("sidebar-frames.json");
  await writeFile(framesPath, JSON.stringify(measurement, null, 2));
  await testInfo.attach("sidebar-frames.json", {
    path: framesPath,
    contentType: "application/json",
  });
  expect(measurement.some((frame) => frame.collapsed === "true")).toBe(true);
  expect(measurement.at(-1)?.collapsed).toBe("false");
  expect(measurement.every((frame) => frame.sameNodes)).toBe(true);
  for (const index of [0, 1]) {
    const values = measurement.map((frame) => frame.x[index]!);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.6);
  }
});

for (const language of ["zh", "en"] as const) {
  test(`title menu text aligns vertically with the app icon (${language})`, async ({
    page,
  }, testInfo) => {
    await seedBrowserSettings(page, {
      language,
      theme: "light",
      background: "plain",
      sidebarCollapsed: false,
    });
    await page.goto("./#/");
    await page.evaluate(() => document.fonts.ready);
    const measurement = await page.evaluate(() => {
      const title = document.querySelector(".app-title-bar")!;
      const icon = title.querySelector("img")!.getBoundingClientRect();
      const center = icon.y + icon.height / 2;
      return {
        center,
        menus: Array.from(
          title.querySelectorAll(".app-title-menu-trigger"),
          (menu) => {
            const range = document.createRange();
            range.selectNodeContents(menu.firstChild!);
            const text = range.getBoundingClientRect();
            const button = menu.getBoundingClientRect();
            const style = getComputedStyle(menu);
            const context = document.createElement("canvas").getContext("2d")!;
            context.font = style.font;
            const ink = context.measureText(menu.textContent ?? "");
            return {
              name: menu.textContent,
              textY: text.y,
              textHeight: text.height,
              textCenter: text.y + text.height / 2,
              inkCenter:
                text.y +
                ink.fontBoundingBoxAscent +
                (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) /
                  2,
              buttonCenter: button.y + button.height / 2,
              font: style.font,
              lineHeight: style.lineHeight,
              paddingTop: style.paddingTop,
              paddingBottom: style.paddingBottom,
            };
          },
        ),
      };
    });
    const geometryPath = testInfo.outputPath("title-geometry.json");
    await writeFile(geometryPath, JSON.stringify(measurement, null, 2));
    await testInfo.attach("title-geometry.json", {
      path: geometryPath,
      contentType: "application/json",
    });
    await page
      .locator(".app-title-bar")
      .screenshot({ path: testInfo.outputPath("title-bar.png") });
    for (const menu of measurement.menus) {
      expect(Math.abs(menu.buttonCenter - measurement.center)).toBeLessThan(
        0.6,
      );
      expect(Math.abs(menu.inkCenter - measurement.center)).toBeLessThan(1);
    }
  });
}

async function seed(page: Page, motion = "reduced") {
  await seedBrowserSettings(page, {
    motion,
    theme: "light",
    background: "plain",
  });
}

for (const language of ["zh", "en"] as const) {
  test(`send mode converts the editable draft and keeps byte information passive (${language})`, async ({
    page,
  }, testInfo) => {
    await seedBrowserSettings(page, {
      language,
      theme: language === "zh" ? "dark" : "light",
      background: "plain",
      sidebarCollapsed: true,
    });
    await page.goto("./#/");
    const input = page.locator(".workbench-draft");
    const frame = page.locator(".workbench-draft-frame");
    const send = page.getByRole("region", {
      name: language === "zh" ? "发送" : "Send",
      exact: true,
    });
    await input.fill("你好\nA");
    await expect(page.locator(".workbench-draft-bytes")).toHaveText("8 B");
    await expect(
      page.locator(".workbench-preview-trigger,.workbench-byte-preview"),
    ).toHaveCount(0);
    const geometry = await frame.evaluate((outer) => {
      const input = outer.querySelector("textarea")!;
      const label = outer.querySelector(".workbench-draft-bytes")!;
      const frame = outer.getBoundingClientRect(),
        body = input.getBoundingClientRect(),
        count = label.getBoundingClientRect();
      return {
        frame: {
          y: frame.y,
          bottom: frame.bottom,
          height: frame.height,
          right: frame.right,
        },
        body: { bottom: body.bottom, height: body.height },
        count: {
          y: count.y,
          right: count.right,
          bottom: count.bottom,
          tabIndex: (label as HTMLElement).tabIndex,
          tag: label.tagName,
          pointerEvents: getComputedStyle(label).pointerEvents,
        },
      };
    });
    expect(geometry.count.tag).toBe("SPAN");
    expect(geometry.count.tabIndex).toBe(-1);
    expect(geometry.count.pointerEvents).toBe("none");
    expect(geometry.body.height).toBeGreaterThan(25);
    expect(geometry.body.bottom).toBeLessThanOrEqual(geometry.count.y + 0.5);
    expect(geometry.count.bottom).toBeLessThan(geometry.frame.bottom);
    expect(geometry.count.right).toBeLessThan(geometry.frame.right - 8);
    await send.getByRole("radio", { name: "HEX", exact: true }).click();
    await expect(input).toHaveValue("E4 BD A0 E5 A5 BD 0A 41");
    await expect(page.locator(".workbench-draft-bytes")).toHaveText("8 B");
    const converted = await frame.boundingBox();
    expect(converted?.y).toBe(geometry.frame.y);
    expect(converted?.height).toBe(geometry.frame.height);
    await page.screenshot({ path: testInfo.outputPath("send-hex.png") });
    await send
      .getByRole("radio", {
        name: language === "zh" ? "文本" : "Text",
        exact: true,
      })
      .click();
    await expect(input).toHaveValue("你好\nA");
    await page.screenshot({ path: testInfo.outputPath("send-text.png") });
  });
}

test("settings section shortcuts keep the route and move keyboard focus to visible groups", async ({
  page,
}) => {
  await seed(page);
  await page.goto("./#/settings");
  const navigation = page.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  for (const [name, id] of [
    ["Appearance", "settings-appearance"],
    ["Terminal typography", "settings-terminalTypography"],
    ["Window skins", "settings-skin"],
    ["Window & workspace", "settings-layout"],
    ["Windows & startup", "settings-window"],
    ["Network", "settings-network"],
  ] as const) {
    const shortcut = navigation.getByRole("button", { name, exact: true });
    await shortcut.focus();
    await page.keyboard.press("Enter");
    const group = page.locator("#" + id);
    await expect(group).toBeFocused();
    await expect(group).toBeInViewport();
    await expect(page).toHaveURL(/#\/settings$/);
  }
});

test("controlled dialogs and search cancellation restore the keyboard position", async ({
  page,
}) => {
  await seed(page);
  await page.goto("./#/settings");
  const reset = page.getByRole("button", {
    name: "Reset preferences",
    exact: true,
  });
  await reset.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reset).toBeFocused();

  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("theme");
  await search.press("ArrowDown");
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await search.fill("radius");
  await search.press("Enter");
  await expect(page.locator("#settings-radius")).toBeFocused();
});
