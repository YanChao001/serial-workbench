/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

test("continuous key repeat and bulk insertions paint promptly without losing draft text", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true, theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
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
  for (let index = 0; index < 32; index++) await page.keyboard.down("0");
  await page.keyboard.up("0");
  for (let index = 0; index < 8; index++)
    await client.send("Input.insertText", { text: block });
  const nativeSamples = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const value: unknown = Reflect.get(window, "nativeInputSamples");
    if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
      throw new Error("Missing native samples");
    return value as number[];
  });
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
  };
  await writeFile(
    info.outputPath("composer-input-latency.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      p95,
      max: evidence.max,
      samples: samples.length,
      nativeP95: [...nativeSamples].sort((a, b) => a - b)[
        Math.floor(nativeSamples.length * 0.95)
      ],
    }),
  );
  expect(samples).toHaveLength(40);
  expect(p95).toBeLessThan(100);
});

for (const language of ["en", "zh"] as const)
  test(`clearing a send draft preserves the other view and immediately saves and sends its latest text (${language})`, async ({
    page,
  }, info) => {
    const words = language === "zh" ? zhCN : en;
    await seedWorkbenchFixture(page, {
      language,
      sidebarCollapsed: true,
      theme: language === "zh" ? "dark" : "light",
    });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    const draft = page.getByRole("textbox", {
      name: words["workbench.draft"],
      exact: true,
    });
    await draft.fill("FIRST DRAFT");
    await page
      .getByRole("button", {
        name: words["workbench.duplicateView"],
        exact: true,
      })
      .click();
    const tabs = page
      .getByRole("tablist", { name: words["workbench.sessions"] })
      .getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await draft.fill("SECOND DRAFT");
    await tabs.nth(0).click();
    await expect(draft).toHaveValue("FIRST DRAFT");
    const clear = page.getByRole("button", {
      name: words["workbench.clearDraft"],
      exact: true,
    });
    await clear.click();
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("");
    await expect(clear).toBeDisabled();
    await expect(
      page.getByRole("note", { name: words["workbench.draftByteCount"] }),
    ).toHaveText("0 B");
    await page.screenshot({ path: info.outputPath("send-draft-erased.png") });
    await tabs.nth(1).click();
    await expect(draft).toHaveValue("SECOND DRAFT");
    await draft.press("End");
    await draft.press("0");
    await page
      .getByRole("button", { name: words["workbench.saveDrafts"], exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(
            window.workbenchFixture.clientStateWrites.at(-1)?.drafts ?? {},
          ),
        ),
      )
      .toEqual(expect.arrayContaining(["", "SECOND DRAFT0"]));
    await page
      .getByRole("button", { name: words["workbench.send"], exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.at(-1)))
      .toBe(Buffer.from("SECOND DRAFT0").toString("base64"));
  });
