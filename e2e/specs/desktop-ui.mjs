import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import { appearance, invoke, navigate, ready } from "../helpers.mjs";
import { nativeValue, readSettings } from "../settings.mjs";
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
    const original = (await readSettings()).settings;
    try {
      await patchSettings({ motion: "full", sidebarCollapsed: false });
      await navigate("/settings");
      await settledAppearance({ motion: "full" });
      await $("button=Add wallpapers").waitForEnabled();
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

  it("imports a real local raster file and shares its authorized reference between windows", async () => {
    const original = (await readSettings()).settings;
    const main = await browser.getWindowHandle();
    let secondary;
    try {
      await patchSettings({
        language: "en",
        background: { kind: "preset", value: "plain" },
        sidebarCollapsed: false,
      });
      await settledAppearance({ language: "en", background: "plain" });
      await navigate("/settings");
      const add = await $("button=Add wallpapers");
      await add.waitForEnabled();
      // feature=e2e 的固定系统选择器夹具继续经过真实 Rust 文件检查、登记和授权。
      await add.click();
      await browser.waitUntil(
        async () => (await appearance()).background === "custom",
      );
      const loadedImage = () =>
        browser.execute(() => {
          const image = document.querySelector("[data-custom-background]");
          return (
            !!image?.complete &&
            image.naturalWidth === 1800 &&
            image.naturalHeight === 1000
          );
        });
      try {
        await browser.waitUntil(loadedImage);
      } catch (error) {
        try {
          // finally 会恢复背景；先保留真实失败状态，再做只读解析诊断。
          await browser.saveScreenshot(
            "artifacts/e2e/fresh/media-before-cleanup.png",
          );
          const diagnostic = {};
          try {
            diagnostic.dom = await browser.execute(() => {
              const image = document.querySelector("[data-custom-background]");
              return image
                ? {
                    complete: image.complete,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    protocol: new URL(image.currentSrc || image.src).protocol,
                  }
                : { present: false };
            });
            const snapshot = await readSettings();
            diagnostic.backgroundKind = snapshot.settings.background.kind;
            if (snapshot.settings.background.kind === "media") {
              const { generation } = await nativeValue("host_attachment");
              const resolved = await invoke("media_resolve", {
                reference: snapshot.settings.background.reference,
                generation,
              });
              if (resolved.ok) {
                try {
                  diagnostic.resolution = {
                    ok: true,
                    mime: resolved.value.mime,
                    protocol: new URL(resolved.value.url).protocol,
                  };
                } finally {
                  await invoke("media_release", {
                    ticket: resolved.value.ticket,
                    generation,
                  });
                }
              } else
                diagnostic.resolution = {
                  ok: false,
                  failure: resolved.failure,
                };
            }
          } catch (failure) {
            diagnostic.error = String(failure);
          }
          writeFileSync(
            "artifacts/e2e/fresh/media-load-failure.json",
            JSON.stringify(diagnostic, null, 2),
          );
        } catch {
          console.warn("Media diagnostic collection did not complete.");
        }
        throw error;
      }
      await browser.waitUntil(() =>
        browser.execute(() => {
          const preview = document.querySelector(
            "button[aria-label='Use wallpaper: e2e-background.png'] img",
          );
          return (
            !!preview?.complete &&
            preview.naturalWidth === 1800 &&
            preview.naturalHeight === 1000
          );
        }),
      );
      let selection;
      await browser.waitUntil(async () => {
        const snapshot = await readSettings();
        selection = snapshot.settings.background;
        return (
          selection.kind === "media" &&
          snapshot.client.state.gallery.some(
            (entry) =>
              entry.name === "e2e-background.png" &&
              entry.reference.id === selection.reference.id,
          )
        );
      });
      assert.equal(selection.reference.kind, "file");
      assert.equal(typeof selection.reference.revision, "string");
      assert.equal("dataUrl" in selection, false);
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
      await browser.waitUntil(loadedImage);
      assert.deepEqual((await readSettings()).settings.background, selection);
      await navigate("/settings");
      await $("label=Show full image").click();
      await browser.waitUntil(
        async () =>
          (await readSettings()).settings.background.fit === "contain",
      );
      await browser.switchToWindow(main);
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector("[data-custom-background]"))
              .objectFit === "contain",
        ),
      );
      writeFileSync(
        join(
          process.env.STARTER_E2E_DATA_ROOT,
          "background-image-fixture.json",
        ),
        JSON.stringify(selection.reference),
      );
      await add.scrollIntoView({ block: "center" });
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
