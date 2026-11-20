/// <reference lib="dom" />
import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";

const keyRepeats = 32;
const bulkInsertions = 8;
const referenceMs = 100;
const compareNative = process.env.SWB_TEST_COMPOSER_NATIVE_CONTROL === "1";
const diagnose = process.env.SWB_TEST_COMPOSER_PERF === "1" || compareNative;

// 页面快照会干扰诊断采样。
if (diagnose) test.use({ trace: "off" });

test("continuous key repeat and bulk insertions preserve the complete draft", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const draft = page.getByRole("textbox", {
    name: "Send draft",
    exact: true,
  });
  const initial = "0".repeat(96 * 1024);
  const block = "1234567890".repeat(3277);
  await draft.fill(initial);
  const client = await page.context().newCDPSession(page);
  if (diagnose) {
    await page.evaluate(() => document.fonts.ready);
    await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await draft.evaluate((element) => {
      const samples: number[] = [];
      element.addEventListener(
        "input",
        () => {
          const started = performance.now();
          requestAnimationFrame(() =>
            samples.push(performance.now() - started),
          );
        },
        true,
      );
      Object.assign(window, { composerInputSamples: samples });
    });
  }
  await draft.focus();
  await enterDraft(page, client, block);
  await expect(draft).toHaveValue(
    initial + "0".repeat(keyRepeats) + block.repeat(bulkInsertions),
  );

  if (!diagnose) return;
  const samples = await readInputSamples(page, "composerInputSamples");
  const nativeSamples = compareNative
    ? await measureNativeControl(draft, client, initial, block)
    : undefined;
  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const breakdown = {
    draft: summarizeInputSamples(samples),
    native: nativeSamples && summarizeInputSamples(nativeSamples),
  };
  const evidence = {
    scope:
      "Headless Chromium with 4x CPU throttle. Measures input event to animation frame callback for repeated keydown and CDP bulk text insertion.",
    referenceMs,
    samples,
    nativeSamples,
    breakdown,
    workers: info.config.workers,
  };
  await writeFile(
    info.outputPath("composer-input-latency.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify({ referenceMs, ...breakdown }));
});

async function enterDraft(page: Page, client: CDPSession, block: string) {
  for (let index = 0; index < keyRepeats; index++)
    await page.keyboard.down("0");
  await page.keyboard.up("0");
  for (let index = 0; index < bulkInsertions; index++)
    await client.send("Input.insertText", { text: block });
}

async function readInputSamples(page: Page, key: string) {
  const samples = await page.evaluate(async (key) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const value: unknown = Reflect.get(window, key);
    if (
      !Array.isArray(value) ||
      !value.every((item): item is number => typeof item === "number")
    )
      throw new Error(`Missing input samples for ${key}`);
    return value;
  }, key);
  expect(samples).toHaveLength(keyRepeats + bulkInsertions);
  return samples;
}

function summarizeInputSamples(samples: number[]) {
  const summarize = (group: number[]) => ({
    max: Math.max(...group),
    atOrAboveReference: group.filter((value) => value >= referenceMs).length,
  });
  return {
    keyRepeat: summarize(samples.slice(0, keyRepeats)),
    bulkInsertion: summarize(samples.slice(keyRepeats)),
  };
}

async function measureNativeControl(
  draft: Locator,
  client: CDPSession,
  initial: string,
  block: string,
) {
  await draft.evaluate((element, initial) => {
    if (!(element instanceof HTMLTextAreaElement))
      throw new Error("Missing textarea");
    const native = element.cloneNode(false);
    if (!(native instanceof HTMLTextAreaElement))
      throw new Error("Missing native control");
    native.removeAttribute("id");
    native.setAttribute("aria-label", "Native benchmark");
    const box = element.getBoundingClientRect();
    Object.assign(native.style, {
      position: "fixed",
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      zIndex: "1000",
    });
    native.value = initial;
    const samples: number[] = [];
    native.addEventListener("input", () => {
      const started = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - started));
    });
    Object.assign(window, { nativeInputSamples: samples });
    element.parentElement!.appendChild(native);
    native.focus();
    native.setSelectionRange(initial.length, initial.length);
  }, initial);
  const page = draft.page();
  await enterDraft(page, client, block);
  return readInputSamples(page, "nativeInputSamples");
}
