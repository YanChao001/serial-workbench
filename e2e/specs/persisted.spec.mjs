import { readSettings } from "../settings.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browser, $ } from "@wdio/globals";
import {
  appearance,
  invoke,
  ready,
  navigate,
  windowPlacement,
  recordWindowPlacement,
} from "../helpers.mjs";

describe("App process restart", () => {
  it("restores native settings in a new app process with the same isolated user data", async () => {
    await ready();
    await browser.waitUntil(async () => {
      const state = await appearance();
      return (
        state.language === "en" &&
        state.background === "sakura" &&
        state.intensity === "70"
      );
    });
    assert.deepEqual(await appearance(), {
      language: "en",
      background: "sakura",
      intensity: "70",
    });
    const settings = await readSettings();
    assert.equal(settings.settings.language, "en");
    assert.deepEqual(settings.settings.background, {
      kind: "preset",
      value: "sakura",
    });
    assert.equal(settings.settings.backgroundIntensity, 70);
    assert.equal(settings.settings.windowPosition, "remember");
    const backgroundFixture = JSON.parse(
      readFileSync(
        join(
          process.env.STARTER_E2E_DATA_ROOT,
          "background-image-fixture.json",
        ),
        "utf8",
      ),
    );
    assert.equal(settings.client.formatVersion, "0.1");
    assert.ok(
      settings.client.state.gallery.some(
        (entry) =>
          entry.reference.hostId === backgroundFixture.hostId &&
          entry.reference.id === backgroundFixture.id,
      ),
    );
    const expectedPosition = JSON.parse(
      readFileSync(
        join(
          process.env.STARTER_E2E_DATA_ROOT,
          "window-placement-fixture.json",
        ),
        "utf8",
      ),
    );
    const started = Date.now();
    let firstObserved;
    let placement;
    const positionDetails = () => ({
      expected: expectedPosition,
      firstObserved,
      actual: placement?.position,
      outerSize: placement?.outerSize,
      workAreas: placement?.workAreas,
      scaleFactor: placement?.scaleFactor,
      elapsedMs: Date.now() - started,
    });
    try {
      // 可见和 IPC 就绪早于异步窗口管理器的位置配置；以真实原生坐标确认恢复。
      await browser.waitUntil(
        async () => {
          placement = await windowPlacement();
          firstObserved ??= placement.position;
          return (
            Math.abs(placement.position.x - expectedPosition.x) <= 2 &&
            Math.abs(placement.position.y - expectedPosition.y) <= 2
          );
        },
        {
          timeoutMsg: "Window manager did not restore the remembered position",
        },
      );
    } catch (error) {
      const diagnostic = recordWindowPlacement(
        "restart-failed",
        positionDetails(),
      );
      throw new Error(
        `Remembered window position changed: ${JSON.stringify(diagnostic)}`,
        { cause: error },
      );
    }
    console.info(
      "Restored window position:",
      recordWindowPlacement("restart-restored", positionDetails()),
    );
    const geometry = await invoke("get_window_geometry");
    assert.equal(geometry.ok, true);
    assert.equal(
      geometry.value.width,
      Math.min(
        geometry.value.maxWidth,
        Math.max(geometry.value.minWidth, 1000),
      ),
    );
    assert.equal(
      geometry.value.height,
      Math.min(
        geometry.value.maxHeight,
        Math.max(geometry.value.minHeight, 680),
      ),
    );
    assert.equal(
      (await invoke("plugin:window|is_visible", { label: "main" })).value,
      true,
    );
    await browser.saveScreenshot(
      "artifacts/e2e/persisted/restarted-window.png",
    );
  });

  it("saves centered startup without moving an existing window", async () => {
    await navigate("/settings");
    const before = (await windowPlacement()).position;
    await $("[data-window-position=center]").click();
    await browser.waitUntil(
      async () => (await readSettings()).settings?.windowPosition === "center",
    );
    assert.deepEqual((await windowPlacement()).position, before);
    assert.equal(
      (await invoke("plugin:window-state|save_window_state", { flags: 2 })).ok,
      true,
    );
  });
});
/* global describe, it */
