/// <reference lib="dom" />
import { expect, test, type CDPSession, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";

// tracing 的页面快照及录屏会干扰输入测量；失败仍保留截图和完整延迟样本。
test.use({ trace: "off" });

test("continuous key repeat and bulk insertions paint promptly without losing draft text", async ({
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
  await draft.fill(initial);
  await page.evaluate(() => document.fonts.ready);
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await draft.evaluate((element) => {
    const samples: number[] = [];
    const record = () => {
      const started = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - started));
    };
    element.addEventListener("input", record, true);
    Object.assign(window, { composerInputSamples: samples });
  });
  await draft.focus();
  for (let index = 0; index < 32; index++) await page.keyboard.down("0");
  await page.keyboard.up("0");
  const block = "1234567890".repeat(3277);
  for (let index = 0; index < 8; index++)
    await client.send("Input.insertText", { text: block });
  await expect(draft).toHaveValue(initial + "0".repeat(32) + block.repeat(8));
  const samples = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const value: unknown = Reflect.get(window, "composerInputSamples");
    if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
      throw new Error("Missing input samples");
    return value as number[];
  });
  const nativeSamples =
    process.env.SWB_TEST_COMPOSER_NATIVE_CONTROL === "1"
      ? await measureNativeControl(draft, client, initial, block)
      : undefined;
  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  const evidence = {
    scope:
      "Headless Chromium with 4x CPU throttle; real repeated keydown and CDP bulk text insertion, no system clipboard or hardware",
    samples,
    nativeSamples,
    p95,
    max: Math.max(...samples),
    trace: "off",
    workers: info.config.workers,
  };
  await writeFile(
    info.outputPath("composer-input-latency.json"),
    JSON.stringify(evidence, null, 2),
  );
  const sortedNative = nativeSamples?.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      p95,
      max: evidence.max,
      samples: samples.length,
      nativeP95: sortedNative?.[Math.floor(sortedNative.length * 0.95)],
    }),
  );
  expect(samples).toHaveLength(40);
  expect(p95).toBeLessThan(100);
});

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
  const keyboard = draft.page().keyboard;
  for (let index = 0; index < 32; index++) await keyboard.down("0");
  await keyboard.up("0");
  for (let index = 0; index < 8; index++)
    await client.send("Input.insertText", { text: block });
  return draft.page().evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const value: unknown = Reflect.get(window, "nativeInputSamples");
    if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
      throw new Error("Missing native samples");
    return value as number[];
  });
}
