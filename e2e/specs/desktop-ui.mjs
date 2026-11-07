import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import { appearance, invoke, navigate, ready } from "../helpers.mjs";
import {
  patchSettings,
  screenshot,
  settledAppearance,
} from "../appearance.mjs";

export function desktopUiChecks() {
  it("keeps wheel tails native without replaying edge animations in WebView2", async function () {
    if (
      await browser.execute(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      )
    )
      this.skip();
    const original = (await invoke("load_settings_snapshot")).value.settings;
    try {
      await patchSettings({ motion: "full", sidebarCollapsed: false });
      await navigate("/settings");
      await settledAppearance({ motion: "full" });
      await $(".wallpaper-library[aria-busy=false]").waitForExist();
      for (const selector of ["main", ".app-sidebar-navigation"]) {
        const result = await browser.execute(async (target) => {
          const viewport = document.querySelector(target);
          viewport.scrollTop = viewport.scrollHeight;
          const height = viewport.scrollHeight;
          let scripted = false;
          for (const delta of [120, 100, 80, 50, 30, 20, 12, 6, 3, 1]) {
            viewport.dispatchEvent(
              new WheelEvent("wheel", { deltaY: delta, bubbles: true }),
            );
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            let node = viewport.querySelector(
              ".app-page-content, [role='group']",
            );
            while (node && node !== viewport) {
              scripted ||=
                node.getAnimations().length > 0 ||
                getComputedStyle(node).translate !== "none";
              node = node.parentElement;
            }
          }
          return {
            scripted,
            policy: getComputedStyle(viewport).overscrollBehaviorY,
            stableRange: viewport.scrollHeight === height,
            documentTop: document.scrollingElement.scrollTop,
          };
        }, selector);
        assert.equal(
          result.scripted,
          false,
          selector + " leaves edge feedback to WebView2",
        );
        assert.equal(result.policy, "contain");
        assert.equal(result.stableRange, true);
        assert.equal(result.documentTop, 0);
      }
    } finally {
      await patchSettings(original);
      await settledAppearance({ motion: original.motion });
    }
  });

  it("imports a real local raster image and synchronizes its native snapshot between windows", async () => {
    const original = (await invoke("load_settings_snapshot")).value.settings;
    const main = await browser.getWindowHandle();
    let secondary;
    try {
      await patchSettings({
        language: "en",
        background: "plain",
        customBackground: null,
        sidebarCollapsed: false,
      });
      await settledAppearance({ language: "en", background: "plain" });
      await navigate("/settings");
      const fileInput = await $(".wallpaper-library input[type=file]");
      await fileInput.waitForExist();
      // 图库订阅和首次读取完成前输入仍被禁用，不能提前注入会被丢弃的 change。
      await fileInput.waitForEnabled();
      // 由真实 Canvas 生成无用户数据的文件夹具，经同一 file input / React 导入入口处理。
      await browser.execute(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1800;
        canvas.height = 1000;
        const context = canvas.getContext("2d");
        const gradient = context.createLinearGradient(0, 0, 1800, 1000);
        gradient.addColorStop(0, "#476d98");
        gradient.addColorStop(1, "#c6d9bf");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error("Could not create the PNG import fixture");
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([blob], "e2e-background.png", { type: "image/png" }),
        );
        const input = document.querySelector(
          ".wallpaper-library input[type=file]",
        );
        if (!input || input.disabled)
          throw new Error("Wallpaper import input became unavailable");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      try {
        await browser.waitUntil(
          async () => (await appearance()).background === "custom",
        );
      } catch (error) {
        const diagnostic = await browser
          .execute(() => ({
            background: document.documentElement.dataset.background,
            inputDisabled: document.querySelector(
              ".wallpaper-library input[type=file]",
            )?.disabled,
            libraryBusy: document
              .querySelector(".wallpaper-library")
              ?.getAttribute("aria-busy"),
            wallpapers: document.querySelectorAll(".wallpaper-card").length,
            errors: [
              ...document.querySelectorAll(
                '[data-sonner-toast][data-type="error"]',
              ),
            ].map((toast) => toast.textContent?.slice(0, 500)),
          }))
          .catch((cause) => ({ captureError: cause.message }));
        try {
          writeFileSync(
            join(
              "artifacts",
              "e2e",
              process.env.STARTER_E2E_PHASE,
              "wallpaper-import-failed.json",
            ),
            JSON.stringify(diagnostic, null, 2),
          );
        } catch (cause) {
          console.warn(
            "Could not save wallpaper import diagnostics:",
            cause.message,
          );
        }
        throw error;
      }
      await browser.waitUntil(() =>
        browser.execute(() => {
          const image = document.querySelector("[data-custom-background]");
          return (
            image?.complete &&
            image.naturalWidth > 0 &&
            image.naturalWidth <= 1600
          );
        }),
      );
      let imported;
      await browser.waitUntil(async () => {
        const snapshot = await invoke("load_settings_snapshot");
        imported = snapshot.value.settings.customBackground;
        return imported?.name === "e2e-background.png";
      });
      assert.ok(imported.dataUrl.length <= 96 * 1024);
      assert.match(imported.dataUrl, /^data:image\/(webp|jpeg);base64,/);
      assert.equal((await invoke("open_secondary_window")).ok, true);
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length === 2,
      );
      secondary = (await browser.getWindowHandles()).find(
        (handle) => handle !== main,
      );
      await browser.switchToWindow(secondary);
      await ready("secondary");
      await browser.waitUntil(
        async () => (await appearance()).background === "custom",
      );
      assert.equal(
        await $("[data-custom-background]").getAttribute("src"),
        imported.dataUrl,
      );
      await navigate("/settings");
      await $("button[role=combobox][aria-label='Image fit']").click();
      await $(
        "//*[@role='option'][normalize-space()='Show full image']",
      ).click();
      await browser.waitUntil(async () => {
        const snapshot = await invoke("load_settings_snapshot");
        return snapshot.value.settings.customBackground?.fit === "contain";
      });
      await browser.switchToWindow(main);
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector("[data-custom-background]"))
              .objectFit === "contain",
        ),
      );
      const fixture = (await invoke("load_settings_snapshot")).value.settings
        .customBackground;
      writeFileSync(
        join(
          process.env.STARTER_E2E_DATA_ROOT,
          "background-image-fixture.json",
        ),
        JSON.stringify(fixture),
      );
      await $(".wallpaper-library").scrollIntoView({ block: "center" });
      await screenshot("desktop-custom-background.png");
    } finally {
      await browser.switchToWindow(main);
      if (secondary && (await browser.getWindowHandles()).includes(secondary)) {
        await invoke("plugin:window|close", { label: "secondary" });
        await browser.waitUntil(
          async () => (await browser.getWindowHandles()).length === 1,
        );
      }
      await patchSettings(original);
    }
  });
}
