import { readSettings } from "../settings.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  appearance,
  invoke,
  language,
  openDeepLink,
  ready,
  placeNearWorkAreaCorner,
  recordWindowPlacement,
  windowPlacement,
} from "../helpers.mjs";

import { desktopUiChecks } from "./desktop-ui.mjs";
import { workbenchChecks } from "./workbench.mjs";
const execute = promisify(execFile);

describe("Real Tauri desktop", () => {
  it("reveals the main window with native settings and the workspace shell", async () => {
    await ready();
    const settings = await readSettings();
    assert.equal(typeof settings.revision, "string");
    assert.equal(typeof settings.client.revision, "string");
    await $("[data-testid=serial-workbench-shell]").waitForExist();
    await $("main").waitForDisplayed();
  });

  it("stays responsive when the application is launched repeatedly in parallel", async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        execute(process.env.STARTER_E2E_BINARY, [], {
          timeout: 7000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        }),
      ),
    );
    assert.equal((await browser.getWindowHandles()).length, 1);
    assert.equal(typeof (await readSettings()).revision, "string");
    await $("#root main").waitForDisplayed();
  });

  it("switches both languages through settings and saves preferences", async () => {
    for (const locale of ["zh", "en"]) {
      await language(locale);
      await browser.waitUntil(
        async () => (await readSettings()).settings.language === locale,
      );
      assert.equal(
        await $("main h1").getText(),
        locale === "zh" ? "\u8bbe\u7f6e" : "Settings",
      );
    }
  });

  workbenchChecks();
  desktopUiChecks();

  it("uses the actual native window maximize, restore and minimize controls", async () => {
    await language("en");
    // 小工作区先建立与最大化尺寸不同的正常窗口，保证原生缩放有明确的还原目标。
    const savedGeometry =
      process.platform === "darwin"
        ? await invoke("get_window_geometry")
        : null;
    try {
      if (savedGeometry) {
        assert.equal(savedGeometry.ok, true);
        const { minWidth, minHeight } = savedGeometry.value;
        const resized = await invoke("set_window_size", {
          width: minWidth,
          height: minHeight,
        });
        assert.equal(resized.ok, true);
        await browser.waitUntil(async () => {
          const current = await invoke("get_window_geometry");
          return (
            current.ok &&
            current.value.width === minWidth &&
            current.value.height === minHeight &&
            !(await invoke("plugin:window|is_maximized", { label: "main" }))
              .value
          );
        });
      }
      const original = await invoke("plugin:window|is_maximized", {
        label: "main",
      });
      assert.equal(original.ok, true);
      const toggle = async () => {
        // macOS 保留原生红绿灯，浏览器 DOM 中没有自绘窗口按钮。
        if (process.platform === "darwin") {
          assert.equal(
            (await invoke("plugin:window|toggle_maximize", { label: "main" }))
              .ok,
            true,
          );
        } else {
          await $(
            "button[aria-label='Maximize'], button[aria-label='Restore']",
          ).click();
        }
      };
      await toggle();
      await browser.waitUntil(
        async () =>
          (await invoke("plugin:window|is_maximized", { label: "main" }))
            .value !== original.value,
      );
      await toggle();
      await browser.waitUntil(
        async () =>
          (await invoke("plugin:window|is_maximized", { label: "main" }))
            .value === original.value,
      );
      if (process.platform === "darwin")
        assert.equal(
          (await invoke("plugin:window|minimize", { label: "main" })).ok,
          true,
        );
      else await $("button[aria-label='Minimize']").click();
      await browser.waitUntil(
        async () =>
          (await invoke("plugin:window|is_minimized", { label: "main" }))
            .value === true,
      );
      assert.equal(
        (await invoke("plugin:window|unminimize", { label: "main" })).ok,
        true,
      );
      await invoke("plugin:window|set_focus", { label: "main" });
    } finally {
      if (savedGeometry?.ok) {
        const restored = await invoke("set_window_size", {
          width: savedGeometry.value.width,
          height: savedGeometry.value.height,
        });
        assert.equal(restored.ok, true);
        await browser.waitUntil(async () => {
          const current = await invoke("get_window_geometry");
          return (
            current.ok &&
            current.value.width === savedGeometry.value.width &&
            current.value.height === savedGeometry.value.height
          );
        });
      }
    }
  });

  (process.platform === "win32" ? it : it.skip)(
    "fills the Windows monitor in immersive fullscreen and restores normal and maximized windows",
    async () => {
      const measure = () =>
        browser.execute(async () => {
          const win = window.__TAURI__.window.getCurrentWindow();
          const [fullscreen, maximized, inner, outer, position, scale] =
            await Promise.all([
              win.isFullscreen(),
              win.isMaximized(),
              win.innerSize(),
              win.outerSize(),
              win.outerPosition(),
              win.scaleFactor(),
            ]);
          const main = document
            .querySelector(".app-main")
            .getBoundingClientRect();
          return {
            fullscreen,
            maximized,
            inner,
            outer,
            position,
            scale,
            immersive: document
              .querySelector(".app-shell")
              .classList.contains("app-shell-immersive"),
            viewport: {
              width: innerWidth * devicePixelRatio,
              height: innerHeight * devicePixelRatio,
            },
            main: {
              left: main.left * devicePixelRatio,
              top: main.top * devicePixelRatio,
              right: main.right * devicePixelRatio,
              bottom: main.bottom * devicePixelRatio,
            },
          };
        });
      // 原生尺寸是物理像素，CSS 视口按 DPR 换算；只容忍像素舍入误差。
      const near = (actual, expected) => Math.abs(actual - expected) <= 2;
      const sameGeometry = (actual, expected) =>
        near(actual.inner.width, expected.inner.width) &&
        near(actual.inner.height, expected.inner.height) &&
        near(actual.outer.width, expected.outer.width) &&
        near(actual.outer.height, expected.outer.height) &&
        near(actual.position.x, expected.position.x) &&
        near(actual.position.y, expected.position.y);
      const waitFor = async (matches, message) => {
        let actual;
        try {
          await browser.waitUntil(
            async () => {
              actual = await measure();
              return matches(actual);
            },
            { timeoutMsg: message },
          );
        } catch (error) {
          throw new Error(`${message}: ${JSON.stringify(actual)}`, {
            cause: error,
          });
        }
        return actual;
      };
      const setMaximized = async (value) => {
        if ((await measure()).maximized !== value) {
          const toggled = await invoke("plugin:window|toggle_maximize", {
            label: "main",
          });
          assert.equal(toggled.ok, true);
        }
        await waitFor(
          (state) => !state.fullscreen && state.maximized === value,
          `Window did not reach maximized=${value}`,
        );
      };
      const original = await measure();
      assert.equal(original.fullscreen, false);
      const geometry = await invoke("get_window_geometry");
      assert.equal(geometry.ok, true);
      let normal;
      try {
        await setMaximized(false);
        normal = await waitFor(
          (state) =>
            near(state.inner.width, geometry.value.width * state.scale) &&
            near(state.inner.height, geometry.value.height * state.scale) &&
            near(state.viewport.width, state.inner.width) &&
            near(state.viewport.height, state.inner.height),
          "Normal window did not restore its client area and WebView viewport",
        );
        const monitors = await browser.execute(() =>
          window.__TAURI__.window.availableMonitors(),
        );
        for (const maximized of [false, true]) {
          await setMaximized(maximized);
          const before = await measure();
          // 使用完整显示器边界；workArea 已扣除任务栏，会漏掉底部黑条。
          const overlap = ({ position, size }) =>
            Math.max(
              0,
              Math.min(
                before.position.x + before.outer.width,
                position.x + size.width,
              ) - Math.max(before.position.x, position.x),
            ) *
            Math.max(
              0,
              Math.min(
                before.position.y + before.outer.height,
                position.y + size.height,
              ) - Math.max(before.position.y, position.y),
            );
          const monitor = monitors.reduce(
            (best, candidate) =>
              !best || overlap(candidate) > overlap(best) ? candidate : best,
            null,
          );
          assert.ok(
            monitor && overlap(monitor) > 0,
            "Window has no visible monitor",
          );
          await browser.execute(() =>
            document.querySelector(".app-main").focus(),
          );
          await browser.keys(Key.F11);
          // 原生物理边界精确比较，自动隐藏任务栏留下的 1px 缺口也应失败。
          await waitFor(
            (state) =>
              state.fullscreen &&
              state.immersive &&
              state.position.x === monitor.position.x &&
              state.position.y === monitor.position.y &&
              state.outer.width === monitor.size.width &&
              state.outer.height === monitor.size.height &&
              state.inner.width === monitor.size.width &&
              state.inner.height === monitor.size.height &&
              near(state.viewport.width, monitor.size.width) &&
              near(state.viewport.height, monitor.size.height) &&
              near(state.main.left, 0) &&
              near(state.main.top, 0) &&
              near(state.main.right, monitor.size.width) &&
              near(state.main.bottom, monitor.size.height),
            `Fullscreen from maximized=${maximized} did not fill ${JSON.stringify(monitor)}`,
          );
          await browser.keys(maximized ? Key.F11 : Key.Escape);
          await waitFor(
            (state) =>
              !state.fullscreen &&
              !state.immersive &&
              state.maximized === before.maximized &&
              sameGeometry(state, before) &&
              near(state.viewport.width, before.viewport.width) &&
              near(state.viewport.height, before.viewport.height),
            `Exiting fullscreen did not restore maximized=${maximized} geometry`,
          );
          await setMaximized(false);
          await waitFor(
            (state) => sameGeometry(state, normal),
            "Fullscreen changed the remembered normal window geometry",
          );
        }
      } finally {
        if ((await measure()).fullscreen) {
          const exited = await invoke("plugin:window|set_fullscreen", {
            label: "main",
            value: false,
          });
          assert.equal(exited.ok, true);
          await waitFor(
            (state) => !state.fullscreen,
            "Cleanup could not exit fullscreen",
          );
        }
        await setMaximized(false);
        const restored = await invoke("set_window_size", {
          width: geometry.value.width,
          height: geometry.value.height,
        });
        assert.equal(restored.ok, true);
        if (normal) {
          await browser.execute(async (position) => {
            await window.__TAURI__.window
              .getCurrentWindow()
              .setPosition(
                new window.__TAURI__.dpi.PhysicalPosition(
                  position.x,
                  position.y,
                ),
              );
          }, normal.position);
          await waitFor(
            (state) => sameGeometry(state, normal),
            "Cleanup did not restore normal window geometry",
          );
        }
        await setMaximized(original.maximized);
      }
    },
  );

  it("recovers an oversized off-screen window into an available work area", async () => {
    const measure = () =>
      browser.execute(async () => {
        const win = window.__TAURI__.window.getCurrentWindow();
        return {
          size: await win.innerSize(),
          outerSize: await win.outerSize(),
          position: await win.outerPosition(),
          maximized: await win.isMaximized(),
          scale: await win.scaleFactor(),
        };
      });
    const geometry = await invoke("get_window_geometry");
    assert.equal(geometry.ok, true);
    const original = { ...(await measure()), geometry: geometry.value };
    const failures = [];
    const recordFailure = async (checkpoint) => {
      try {
        recordWindowPlacement(checkpoint, {
          saved: original,
          current: {
            ...(await measure()),
            geometry: await invoke("get_window_geometry"),
          },
        });
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      await browser.execute(async () => {
        const win = window.__TAURI__.window.getCurrentWindow();
        const { PhysicalSize, PhysicalPosition } = window.__TAURI__.dpi;
        if (await win.isMaximized()) await win.toggleMaximize();
        await win.setSize(new PhysicalSize(5000, 3500));
        await win.setPosition(new PhysicalPosition(50000, 50000));
      });
      await browser.waitUntil(
        async () =>
          browser.execute(async () => {
            const { getCurrentWindow, availableMonitors } =
              window.__TAURI__.window;
            const win = getCurrentWindow();
            const size = await win.outerSize();
            const position = await win.outerPosition();
            const monitors = await availableMonitors();
            return (
              size.width > 0 &&
              size.height > 0 &&
              monitors.some(
                ({ workArea }) =>
                  position.x >= workArea.position.x - 2 &&
                  position.y >= workArea.position.y - 2 &&
                  position.x + size.width <=
                    workArea.position.x + workArea.size.width + 2 &&
                  position.y + size.height <=
                    workArea.position.y + workArea.size.height + 2,
              )
            );
          }),
        {
          timeout: 10000,
          timeoutMsg: "Window did not recover into a monitor work area",
        },
      );
    } catch (error) {
      failures.push(error);
      await recordFailure("offscreen-recovery-failed");
    }
    try {
      // 通过尺寸契约同时恢复 preferred，避免旧 resize 事件覆盖清理目标。
      const restored = await invoke("set_window_size", {
        width: original.geometry.width,
        height: original.geometry.height,
      });
      assert.equal(restored.ok, true);
      await browser.waitUntil(async () => {
        const current = await measure();
        return (
          current.size.width ===
            Math.round(original.geometry.width * current.scale) &&
          current.size.height ===
            Math.round(original.geometry.height * current.scale)
        );
      });
      await browser.execute(async (saved) => {
        const win = window.__TAURI__.window.getCurrentWindow();
        await win.setPosition(
          new window.__TAURI__.dpi.PhysicalPosition(
            saved.position.x,
            saved.position.y,
          ),
        );
        if ((await win.isMaximized()) !== saved.maximized)
          await win.toggleMaximize();
      }, original);
      await browser.waitUntil(async () => {
        const current = await measure();
        return (
          current.size.width === original.size.width &&
          current.size.height === original.size.height &&
          current.maximized === original.maximized
        );
      });
    } catch (error) {
      failures.push(error);
      await recordFailure("offscreen-cleanup-failed");
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Off-screen recovery, cleanup or diagnostic capture failed",
        { cause: failures[0] },
      );
  });

  it("applies size presets and restores default preferences without moving the window", async () => {
    await language("en");
    const prepared = await invoke("reset_window_geometry", { center: false });
    assert.equal(prepared.ok, true);
    await browser.waitUntil(async () => {
      const result = await invoke("get_window_geometry");
      if (!result.ok) return false;
      const current = result.value;
      return (
        current.width ===
          Math.max(
            current.minWidth,
            Math.min(current.maxWidth, current.defaultWidth),
          ) &&
        current.height ===
          Math.max(
            current.minHeight,
            Math.min(current.maxHeight, current.defaultHeight),
          )
      );
    });
    const initial = await invoke("get_window_geometry");
    assert.equal(initial.ok, true);
    const bounds = initial.value;
    assert.equal(
      bounds.width,
      Math.max(bounds.minWidth, Math.min(bounds.maxWidth, bounds.defaultWidth)),
    );
    assert.equal(
      bounds.height,
      Math.max(
        bounds.minHeight,
        Math.min(bounds.maxHeight, bounds.defaultHeight),
      ),
    );
    const compactFits =
      bounds.minWidth <= 960 &&
      bounds.maxWidth >= 960 &&
      bounds.minHeight <= 640 &&
      bounds.maxHeight >= 640;
    const width = compactFits
      ? 960
      : Math.max(
          bounds.minWidth,
          Math.min(bounds.maxWidth, bounds.defaultWidth),
        );
    const height = compactFits
      ? 640
      : Math.max(
          bounds.minHeight,
          Math.min(bounds.maxHeight, bounds.defaultHeight),
        );
    await browser.execute(async () => {
      const win = window.__TAURI__.window.getCurrentWindow();
      if (!(await win.isMaximized())) await win.toggleMaximize();
    });
    await browser.waitUntil(async () =>
      browser.execute(async () =>
        window.__TAURI__.window.getCurrentWindow().isMaximized(),
      ),
    );
    assert.equal(await $("#window-width").isExisting(), false);
    assert.equal(await $("#window-height").isExisting(), false);
    const preset = await $(
      `[data-window-preset='${compactFits ? "compact" : "standard"}']`,
    );
    await preset.waitForEnabled();
    await preset.click();
    await browser.waitUntil(async () => {
      const result = await invoke("get_window_geometry");
      return (
        result.ok &&
        result.value.width === width &&
        result.value.height === height
      );
    });
    assert.equal(
      await browser.execute(async () =>
        window.__TAURI__.window.getCurrentWindow().isMaximized(),
      ),
      false,
    );
    const position = await browser.execute(async () =>
      window.__TAURI__.window.getCurrentWindow().outerPosition(),
    );
    const centered = await $("[data-window-position=center]");
    await centered.waitForEnabled();
    await centered.click();
    await browser.waitUntil(
      async () => (await readSettings()).settings?.windowPosition === "center",
    );
    const afterPreference = await browser.execute(async () =>
      window.__TAURI__.window.getCurrentWindow().outerPosition(),
    );
    assert.deepEqual(afterPreference, position);
    await $("button=Reset preferences").click();
    assert.equal(await $("[role=dialog] [role=checkbox]").isExisting(), false);
    await $("[role=dialog]").$("button=Reset preferences").click();
    await $("[role=dialog]").waitForExist({ reverse: true });
    const reset = await invoke("get_window_geometry");
    assert.equal(reset.ok, true);
    assert.equal((await readSettings()).settings.windowPosition, "remember");
    assert.equal(
      reset.value.width,
      Math.min(bounds.maxWidth, bounds.defaultWidth),
    );
    assert.equal(
      reset.value.height,
      Math.min(bounds.maxHeight, bounds.defaultHeight),
    );
    const unchanged = await browser.execute(async () =>
      window.__TAURI__.window.getCurrentWindow().outerPosition(),
    );
    assert.ok(
      Math.abs(position.x - unchanged.x) <= 2 &&
        Math.abs(position.y - unchanged.y) <= 2,
    );
    const invalid = await invoke("set_window_size", { width: 1, height: 1 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.failure.code, "INVALID_ARGUMENT");
  });

  it("renders diagnostic JSON as highlighted inert text", async () => {
    await openDeepLink("/diagnostics");
    await $("details:has([data-testid=diagnostics-report]) > summary").click();
    await browser.waitUntil(async () =>
      (await $("[data-testid=diagnostics-report]").getText()).includes(
        "appVersion",
      ),
    );
    const report = await $("[data-testid=diagnostics-report]").getText();
    assert.equal(typeof JSON.parse(report).appVersion, "string");
    const colors = await browser.execute(() => {
      const block = document.querySelector("[data-testid=diagnostics-report]");
      const key = block.querySelector("[data-token=property]");
      return {
        keys: block.querySelectorAll("[data-token=property]").length,
        key: key && getComputedStyle(key).color,
        plain: getComputedStyle(block).color,
      };
    });
    assert.ok(colors.keys > 0);
    assert.notEqual(colors.key, colors.plain);
  });

  it("reuses the secondary native window and synchronizes settings events both ways", async () => {
    const main = await browser.getWindowHandle();
    assert.equal((await browser.getWindowHandles()).length, 1);
    let secondary;
    try {
      assert.equal((await invoke("open_secondary_window")).ok, true);
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length === 2,
      );
      const handles = await browser.getWindowHandles();
      secondary = handles.find((handle) => handle !== main);
      assert.ok(secondary);
      assert.equal((await invoke("open_secondary_window")).ok, true);
      assert.deepEqual(
        (await browser.getWindowHandles()).sort(),
        [...handles].sort(),
      );
      await browser.switchToWindow(secondary);
      await ready("secondary");
      await language("zh");
      await browser.waitUntil(
        async () => (await readSettings()).settings.language === "zh",
        {
          timeoutMsg: "The secondary window did not persist its language edit",
        },
      );
      await browser.switchToWindow(main);
      await browser.waitUntil(
        async () => (await appearance()).language === "zh-CN",
      );
      await language("en");
      await browser.waitUntil(
        async () => (await readSettings()).settings.language === "en",
        { timeoutMsg: "The main window did not persist its language edit" },
      );
      await browser.switchToWindow(secondary);
      await browser.waitUntil(
        async () => (await appearance()).language === "en",
      );
      const secondaryBounds = (await invoke("get_window_geometry")).value;
      assert.equal(
        (
          await invoke("set_window_size", {
            width: Math.min(
              secondaryBounds.maxWidth,
              Math.max(secondaryBounds.minWidth, 980),
            ),
            height: Math.min(
              secondaryBounds.maxHeight,
              Math.max(secondaryBounds.minHeight, 650),
            ),
          })
        ).ok,
        true,
      );
      const secondaryPosition = await browser.execute(async () =>
        window.__TAURI__.window.getCurrentWindow().outerPosition(),
      );
      await browser.switchToWindow(main);
      assert.equal(
        (await invoke("reset_window_geometry", { center: false })).ok,
        true,
      );
      await browser.switchToWindow(secondary);
      await browser.waitUntil(async () => {
        const geometry = (await invoke("get_window_geometry")).value;
        return (
          geometry.width ===
            Math.min(geometry.maxWidth, geometry.defaultWidth) &&
          geometry.height ===
            Math.min(geometry.maxHeight, geometry.defaultHeight)
        );
      });
      const restoredPosition = await browser.execute(async () =>
        window.__TAURI__.window.getCurrentWindow().outerPosition(),
      );
      assert.ok(
        Math.abs(secondaryPosition.x - restoredPosition.x) <= 2 &&
          Math.abs(secondaryPosition.y - restoredPosition.y) <= 2,
      );
    } catch (error) {
      try {
        const windows = [];
        for (const handle of [main, secondary].filter(Boolean)) {
          if (!(await browser.getWindowHandles()).includes(handle)) continue;
          await browser.switchToWindow(handle);
          const snapshot = await readSettings();
          windows.push({
            handle,
            appearance: await appearance(),
            storedLanguage: snapshot.settings.language,
            sharedRevision: snapshot.revision,
            clientRevision: snapshot.client.revision,
            controls: await browser.execute(() =>
              [
                ...document.querySelectorAll(
                  "button[aria-description][role=combobox]",
                ),
              ].map((control) => ({
                value: control.getAttribute("aria-description"),
                disabled: control.disabled,
              })),
            ),
          });
        }
        writeFileSync(
          "artifacts/e2e/fresh/window-settings-failure.json",
          JSON.stringify(windows, null, 2),
        );
      } catch {
        console.warn("Window settings diagnostic collection did not complete.");
      }
      throw error;
    } finally {
      // 从主窗口关闭本轮次窗口，避免失败后把后续用例的窗口身份颠倒。
      await browser.switchToWindow(main);
      if (secondary && (await browser.getWindowHandles()).includes(secondary)) {
        assert.equal(
          (await invoke("plugin:window|close", { label: "secondary" })).ok,
          true,
        );
        await browser.waitUntil(
          async () => (await browser.getWindowHandles()).length === 1,
        );
      }
    }
  });

  it("persists language and illustration settings for a separate app process", async () => {
    await language("en");
    await $("label:has(input[name='background-skin'][value='sakura'])").click();
    const intensity = await $(
      '[role="slider"][aria-labelledby="skin-intensity-heading"]',
    );
    await intensity.click();
    // 原生驱动的指针点击不保证 Thumb 保持焦点；只聚焦真实控件，数值仍由键盘改变。
    await browser.execute(
      (thumb) => thumb.focus({ preventScroll: true }),
      intensity,
    );
    const moveIntensity = async (key, expected) => {
      assert.equal(
        await intensity.isFocused(),
        true,
        "The slider thumb lost focus",
      );
      await browser.keys(key);
      await browser.waitUntil(
        async () =>
          Number(await intensity.getAttribute("aria-valuenow")) === expected,
        { timeoutMsg: `The focused slider did not reach ${expected}%` },
      );
    };
    const initialIntensity = Number(
      await intensity.getAttribute("aria-valuenow"),
    );
    assert.ok(
      initialIntensity >= 0 &&
        initialIntensity <= 100 &&
        initialIntensity % 10 === 0,
    );
    // 十一档滑条最多十次左移到零，再逐档右移；每一步都验证真实控件值。
    for (let value = initialIntensity; value > 0; value -= 10)
      await moveIntensity(Key.ArrowLeft, value - 10);
    for (let value = 10; value <= 70; value += 10)
      await moveIntensity(Key.ArrowRight, value);
    await browser.waitUntil(async () => {
      const actual = await appearance();
      return (
        actual.language === "en" &&
        actual.background === "sakura" &&
        actual.intensity === "70"
      );
    });
    // 等待异步原生偏好快照落盘，后续进程从同一隔离目录读取。
    await browser.waitUntil(async () => {
      const result = await readSettings();
      return (
        result.settings?.language === "en" &&
        result.settings?.background.kind === "preset" &&
        result.settings?.background.value === "sakura" &&
        result.settings?.backgroundIntensity === 70
      );
    });
    const snapshot = await readSettings();
    const backgroundFixturePath = join(
      process.env.STARTER_E2E_DATA_ROOT,
      "background-image-fixture.json",
    );
    assert.ok(
      existsSync(backgroundFixturePath),
      "The earlier native raster-import prerequisite did not produce the background fixture; check that test's failure first",
    );
    const importedReference = JSON.parse(
      readFileSync(backgroundFixturePath, "utf8"),
    );
    assert.ok(
      snapshot.client.state.gallery.some(
        (entry) =>
          entry.reference.hostId === importedReference.hostId &&
          entry.reference.id === importedReference.id,
      ),
    );
    const geometry = (await invoke("get_window_geometry")).value;
    assert.equal(
      (
        await invoke("set_window_size", {
          width: Math.min(geometry.maxWidth, Math.max(geometry.minWidth, 1000)),
          height: Math.min(
            geometry.maxHeight,
            Math.max(geometry.minHeight, 680),
          ),
        })
      ).ok,
      true,
    );
    await $("[data-window-position=remember]").click();
    await browser.waitUntil(
      async () =>
        (await readSettings()).settings?.windowPosition === "remember",
    );
    const position = await placeNearWorkAreaCorner();
    writeFileSync(
      join(process.env.STARTER_E2E_DATA_ROOT, "window-placement-fixture.json"),
      JSON.stringify(position),
    );
    // 测试 runner 会强制回收进程，先调用原生插件完成正常退出时的位置写盘。
    assert.equal(
      (await invoke("plugin:window-state|save_window_state", { flags: 2 })).ok,
      true,
    );
    recordWindowPlacement("before-restart", {
      expected: position,
      ...(await windowPlacement()),
    });
    // 落盘值不能证明当前窗口的设置效果已成功，保留最终用户可见状态。
    let finalUi;
    let checkFailed = false;
    let checkError;
    try {
      await browser.waitUntil(
        async () => {
          finalUi = await browser.execute(() => {
            const texts = (selector) =>
              [...globalThis.document.querySelectorAll(selector)]
                .filter((element) => element.getClientRects().length > 0)
                .map((element) => element.textContent?.trim() ?? "")
                .filter(Boolean);
            return {
              statuses: texts('[role="status"]'),
              alerts: texts('[role="alert"]'),
              errorToasts: texts('[data-sonner-toast][data-type="error"]'),
            };
          });
          return (
            finalUi.alerts.length === 0 &&
            finalUi.errorToasts.length === 0 &&
            !finalUi.statuses.some((text) =>
              /Settings not saved|设置未保存|Saving…|Syncing settings…|保存中…|同步设置…/.test(
                text,
              ),
            )
          );
        },
        {
          timeoutMsg:
            "The final window retained a settings error or pending save",
        },
      );
    } catch (error) {
      checkFailed = true;
      checkError = error;
    }
    try {
      writeFileSync(
        join(
          "artifacts",
          "e2e",
          process.env.STARTER_E2E_PHASE,
          "final-settings-ui.json",
        ),
        JSON.stringify(finalUi ?? { notObserved: true }, null, 2),
      );
    } catch (error) {
      if (!checkFailed) throw error;
      console.error("Unable to write final settings UI evidence", error);
    }
    if (checkFailed) throw checkError;
  });
});
/* global describe, it */
