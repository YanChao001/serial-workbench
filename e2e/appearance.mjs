import { join } from "node:path";
import { browser } from "@wdio/globals";
export { patchSettings } from "./settings.mjs";

export async function settledAppearance(expected) {
  await browser.waitUntil(() =>
    browser.execute((values) => {
      const root = document.documentElement;
      return Object.entries(values).every(([key, value]) =>
        key === "theme"
          ? root.classList.contains(
              value === "system"
                ? matchMedia("(prefers-color-scheme: dark)").matches
                  ? "dark"
                  : "light"
                : value,
            )
          : key === "language"
            ? root.lang === (value === "zh" ? "zh-CN" : "en")
            : root.dataset[key] === String(value),
      );
    }, expected),
  );
  await browser.execute(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

export async function screenshot(name) {
  await browser.execute(async () => {
    await Promise.all(
      [...document.querySelectorAll(".skin-scene")].map((element) => {
        const image = new Image();
        image.src = getComputedStyle(element).maskImage.slice(5, -2);
        return image.decode();
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await browser.saveScreenshot(
    join("artifacts", "e2e", process.env.STARTER_E2E_PHASE, name),
  );
}
