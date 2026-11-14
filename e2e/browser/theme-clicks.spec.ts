/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

test.use({ reducedMotion: "no-preference" });

test("every interrupted theme click restarts an outward reveal from the control", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    motion: "full",
    currentPage: "settings",
  });
  await page.goto("./#/settings");
  await expect(page.getByRole("searchbox")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const button = page.getByRole("button", {
    name: zhCN["title.toggleTheme"],
    exact: true,
  });
  await button.click();
  const layer = page.locator("[data-theme-reveal]");
  const coverage = () =>
    layer.evaluate((element) => {
      const value = getComputedStyle(element).clipPath;
      const path = new Path2D(
        value.slice(value.indexOf('"') + 1, value.lastIndexOf('"')),
      );
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Missing mask sampler");
      return Array.from({ length: 48 }, (_, index) => {
        const x = ((index % 8) + 0.5) * (innerWidth / 8);
        const y = 80 + (Math.floor(index / 8) + 0.5) * ((innerHeight - 80) / 6);
        return context.isPointInPath(path, x, y, "evenodd");
      });
    });
  await expect(layer).toHaveCount(1, { timeout: 1500 });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const animation = await layer.evaluate(async (element) => {
    const animation = element.getAnimations()[0];
    if (!animation?.effect) throw new Error("Missing theme reveal animation");
    const first = Number(animation.currentTime);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const next = Number(animation.currentTime);
    const duration = Number(animation.effect.getTiming().duration);
    animation.pause();
    animation.currentTime = duration * 0.38;
    return { first, next, duration };
  });
  expect(animation.duration).toBeGreaterThanOrEqual(900);
  expect(animation.duration).toBeLessThanOrEqual(1400);
  expect(animation.next).toBeGreaterThan(animation.first);
  expect(
    await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return (
        document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest("[data-theme-control]") === element
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("circular-theme-reveal.png") });
  // 固定每次新动画的首帧，确认每次都从按钮向外展开。
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      if (this.hasAttribute("data-theme-reveal")) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
  });
  for (const [index, dark] of [true, false, true].entries()) {
    await button.click();
    if (dark) await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(layer).toHaveCount(1, { timeout: 500 });
    expect((await coverage()).every(Boolean)).toBe(true);
    await layer.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (!animation?.effect) throw new Error("Missing outward animation");
      animation.currentTime =
        Number(animation.effect.getTiming().duration) * 0.38;
    });
    const middle = (await coverage()).filter(Boolean).length;
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(48);
    await page.screenshot({ path: info.outputPath(`outward-${index}.png`) });
  }
  await layer.evaluate((element) => element.getAnimations()[0]!.play());
  await expect(layer).toHaveCount(0, { timeout: 1800 });
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe("");
});

test("full motion accepts every rapid theme click without selecting page text", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    motion: "full",
    currentPage: "settings",
  });
  await page.goto("./#/settings");
  await expect(page.getByRole("searchbox")).toBeVisible();
  await page.evaluate(() => {
    const input =
      document.querySelector<HTMLInputElement>("input[type=search]");
    input?.focus();
    window.getSelection()?.removeAllRanges();
  });
  const button = page.getByRole("button", {
    name: zhCN["title.toggleTheme"],
    exact: true,
  });
  for (let index = 0; index < 3; index++) {
    await button.dblclick({ delay: 50 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(
      await page.evaluate(() => window.getSelection()?.toString() ?? ""),
    ).toBe("");
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.settingsWrites.at(-1)?.theme),
    )
    .toBe("dark");
});

test("real clicks at different intervals each start a fresh outward animation", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    motion: "full",
    currentPage: "settings",
  });
  await page.goto("./#/settings");
  await expect(page.getByRole("searchbox")).toBeVisible();
  const button = page.getByRole("button", {
    name: zhCN["title.toggleTheme"],
    exact: true,
  });
  const layer = page.locator("[data-theme-reveal]");
  const samples = [];
  for (const [index, delay] of [
    0, 20, 0, 100, 220, 0, 350, 50, 0, 150, 50, 0,
  ].entries()) {
    if (delay) await page.waitForTimeout(delay);
    await button.click();
    await expect(layer).toHaveCount(1, { timeout: 500 });
    const sample = await layer.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (!(animation?.effect instanceof KeyframeEffect))
        throw new Error("Missing running reveal");
      const frames = animation.effect.getKeyframes();
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Missing mask sampler");
      const coversFarCorner = (value: unknown) => {
        if (typeof value !== "string") throw new Error("Missing circular clip");
        const path = new Path2D(
          value.slice(value.indexOf('"') + 1, value.lastIndexOf('"')),
        );
        return context.isPointInPath(path, 4, innerHeight - 4, "evenodd");
      };
      const previous = Reflect.get(window, "lastClickedThemeReveal");
      Reflect.set(window, "lastClickedThemeReveal", element);
      return {
        fresh: previous !== element,
        duration: Number(animation.effect.getTiming().duration),
        state: animation.playState,
        startsOutside: coversFarCorner(frames[0]?.clipPath),
        endsOutside: coversFarCorner(frames.at(-1)?.clipPath),
      };
    });
    samples.push({ index, delay, ...sample });
    expect(sample.fresh).toBe(true);
    expect(sample.duration).toBeGreaterThanOrEqual(900);
    expect(sample.duration).toBeLessThanOrEqual(1400);
    expect(sample.state).toBe("running");
    expect(sample.startsOutside).toBe(true);
    expect(sample.endsOutside).toBe(false);
    if (index % 2) await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
  }
  await expect(layer).toHaveCount(0, { timeout: 1800 });
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.settingsWrites.at(-1)?.theme),
    )
    .toBe("dark");
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe("");
  await writeFile(
    info.outputPath("theme-click-sequence.json"),
    JSON.stringify(samples, null, 2),
  );
});

test("a loaded workbench reveals in the other direction, finishes, and allows immediate editing", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedWorkbenchFixture(page, {
    theme: "dark",
    motion: "full",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const sample = workbenchStreamItems()[2]!;
  if (sample.kind !== "source" || sample.event.kind !== "rx")
    throw new Error("RX fixture unavailable");
  const payload = "0123456789".repeat(1638);
  const items = Array.from({ length: 12 }, (_, index) => ({
    kind: "source",
    event: {
      ...sample.event,
      eventSeq: String(index + 1),
      payload: {
        bytesBase64: Buffer.from(payload).toString("base64"),
        byteStart: String(index * payload.length),
        byteEnd: String((index + 1) * payload.length),
      },
    },
  }));
  await page.evaluate((items) => window.workbenchFixture.emitRaw(items), items);
  await expect(page.locator(".workbench-stream-row").first()).toBeAttached();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const text = "0".repeat(96 * 1024);
  await draft.fill(text);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const button = page.getByRole("button", {
    name: en["title.toggleTheme"],
    exact: true,
  });
  // 相同正文、相同页面的精简动效切换，作为本机布局耗时对照。
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button.evaluate((element) => {
    element.addEventListener(
      "click",
      () => {
        const started = performance.now();
        requestAnimationFrame(() =>
          Reflect.set(
            window,
            "staticThemeCommitMs",
            performance.now() - started,
          ),
        );
      },
      { capture: true, once: true },
    );
  });
  await button.click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const staticCommitMs: unknown = await page.evaluate(() =>
    Reflect.get(window, "staticThemeCommitMs"),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await button.evaluate((element) => {
    element.addEventListener(
      "click",
      () => {
        const started = performance.now();
        requestAnimationFrame(() =>
          Reflect.set(window, "themeCommitMs", performance.now() - started),
        );
      },
      { capture: true, once: true },
    );
  });
  await button.click();
  const layer = page.locator("[data-theme-reveal]");
  await expect(layer).toHaveCount(1);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await layer.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation?.effect) throw new Error("Missing theme reveal animation");
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) * 0.3;
  });
  // CDP 可读取封闭视觉层，普通页面查询与无障碍树仍只有真实控件。
  const client = await page.context().newCDPSession(page);
  const tree = await client.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const host = await client.send("DOM.querySelector", {
    nodeId: tree.root.nodeId,
    selector: "[data-theme-reveal]",
  });
  const captured = await client.send("DOM.describeNode", {
    nodeId: host.nodeId,
  });
  const shadow = captured.node.shadowRoots?.[0];
  if (!shadow) throw new Error("Missing captured appearance");
  const log = await client.send("DOM.querySelector", {
    nodeId: shadow.nodeId,
    selector: ".workbench-stream-log",
  });
  const object = await client.send("DOM.resolveNode", { nodeId: log.nodeId });
  const alignment = await client.send("Runtime.callFunctionOn", {
    objectId: object.object.objectId,
    functionDeclaration: `function() {
      const live = document.querySelector('.workbench-stream-log');
      const first = this.querySelector('.workbench-stream-row');
      const firstLive = live.querySelector('.workbench-stream-row');
      return {
        top: this.scrollTop - live.scrollTop,
        height: this.scrollHeight - live.scrollHeight,
        firstRow: first.getBoundingClientRect().y - firstLive.getBoundingClientRect().y
      };
    }`,
    returnByValue: true,
  });
  const positions: unknown = alignment.result.value;
  expect(positions).toEqual({ top: 0, height: 0, firstRow: 0 });
  await client.detach();
  await page.screenshot({ path: info.outputPath("workbench-dark-reveal.png") });
  await expect(button).toHaveCount(1);
  const commitMs: unknown = await page.evaluate(() =>
    Reflect.get(window, "themeCommitMs"),
  );
  if (typeof commitMs !== "number" || typeof staticCommitMs !== "number")
    throw new Error("Missing theme latency comparison");
  await writeFile(
    info.outputPath("theme-commit-latency.json"),
    JSON.stringify({
      scope: "Headless Chromium, 96 KiB draft and 192 KiB RX",
      commitMs,
      staticCommitMs,
      revealOverheadMs: commitMs - staticCommitMs,
    }),
  );
  await layer.evaluate((element) => element.getAnimations()[0]!.play());
  await expect(layer).toHaveCount(0, { timeout: 1800 });
  await button.click();
  await expect(layer).toHaveCount(1);
  await layer.evaluate((element) => element.getAnimations()[0]!.pause());
  await draft.click();
  await expect(layer).toHaveCount(0);
  await draft.press("Control+End");
  await draft.press("0");
  await expect(draft).toHaveValue(text + "0");
  expect(errors).toEqual([]);
});

test("resizing, scrolling and changing the motion preference release a pending reveal", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { theme: "dark", motion: "full" });
  await page.goto("./#/");
  const button = page.getByRole("button", {
    name: en["title.toggleTheme"],
    exact: true,
  });
  const layer = page.locator("[data-theme-reveal]");
  await button.click();
  await expect(layer).toHaveCount(1);
  await layer.evaluate((element) => element.getAnimations()[0]!.pause());
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(layer).toHaveCount(0);
  await button.click();
  await expect(layer).toHaveCount(1);
  await layer.evaluate((element) => element.getAnimations()[0]!.pause());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(layer).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await button.click();
  await expect(layer).toHaveCount(1);
  await layer.evaluate((element) => element.getAnimations()[0]!.pause());
  await page.mouse.wheel(0, 100);
  await expect(layer).toHaveCount(0);
});

for (const preference of ["system", "application"] as const)
  test(`reduced motion from the ${preference} applies the theme without a reveal`, async ({
    page,
  }) => {
    if (preference === "system")
      await page.emulateMedia({ reducedMotion: "reduce" });
    await seedWorkbenchFixture(page, {
      theme: "dark",
      motion: preference === "application" ? "reduced" : "full",
    });
    await page.goto("./#/");
    await page
      .getByRole("button", { name: en["title.toggleTheme"], exact: true })
      .click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("[data-theme-reveal]")).toHaveCount(0);
  });

test("an unavailable animation never turns a successful theme change into an error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.hasAttribute("data-theme-reveal")) {
        document.documentElement.dataset.themeAnimationFailures = "1";
        throw new Error("Theme animation unavailable");
      }
      return original.apply(this, args);
    };
  });
  await seedWorkbenchFixture(page, { theme: "dark", motion: "full" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: en["title.toggleTheme"], exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-animation-failures",
    "1",
  );
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("[data-theme-reveal]")).toHaveCount(0);
  expect(errors).toEqual([]);
});
