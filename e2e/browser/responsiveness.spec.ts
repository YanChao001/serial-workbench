/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import type { StreamItem } from "@serial-workbench/contracts";

test.use({ timezoneId: "Asia/Shanghai" });

test("keeps editing responsive while fragmented loopback continues after a reader gap", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1400, height: 925 });
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    backgroundIntensity: 70,
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "打开 Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const sample = workbenchStreamItems()[2]!;
  if (sample.kind !== "source" || sample.event.kind !== "rx")
    throw new Error("RX fixture unavailable");
  const rx = sample.event;
  const payload = "哈".repeat(3333) + "a";
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: sample.event.hostId,
      instanceEpoch: sample.event.instanceEpoch,
      sessionId: sample.event.sessionId,
      sessionEpoch: sample.event.sessionEpoch,
      reason: "reader_overflow",
      missingEventRange: { start: "1", end: "2" },
    },
  };
  await page.evaluate((gap) => window.workbenchFixture.emitRaw([gap]), gap);
  const direction = page.locator(".workbench-gap .workbench-direction");
  await expect(direction).toBeVisible();
  const gapLayout = await direction.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
  }));
  await page.screenshot({
    path: testInfo.outputPath("loopback-gap-before.png"),
  });
  expect(gapLayout.height).toBeLessThanOrEqual(gapLayout.lineHeight + 1);
  const bytes = Buffer.from(payload);
  const delivery = page.evaluate(
    ({ rx, bytesBase64 }) =>
      new Promise<number>((resolve) => {
        const bytes = atob(bytesBase64);
        const channel = new MessageChannel();
        let offset = 0;
        channel.port1.onmessage = () => {
          if (offset >= bytes.length) {
            channel.port1.close();
            channel.port2.close();
            resolve(offset);
            return;
          }
          window.workbenchFixture.emitRaw([
            {
              kind: "source",
              event: {
                ...rx,
                eventSeq: String(offset + 2),
                payload: {
                  byteStart: String(offset),
                  byteEnd: String(offset + 1),
                  bytesBase64: btoa(bytes[offset]!),
                },
              },
            },
          ]);
          offset++;
          channel.port2.postMessage(null);
        };
        channel.port2.postMessage(null);
      }),
    { rx, bytesBase64: bytes.toString("base64") },
  );
  // 交互断言失败时仍观察页面退出导致的迟拒绝。
  void delivery.catch(() => {});
  const draft = page.getByRole("textbox", { name: "发送草稿", exact: true });
  const started = performance.now();
  await draft.fill(payload);
  await draft.pressSequentially("继续编辑", { delay: 0 });
  await expect(draft).toHaveValue(payload + "继续编辑");
  const elapsed = performance.now() - started;
  await writeFile(
    testInfo.outputPath("fragmented-editing.json"),
    JSON.stringify({ elapsedMs: elapsed, bytes: bytes.length }),
  );
  expect(elapsed).toBeLessThan(1500);
  expect(await delivery).toBe(bytes.length);
  await expect(page.getByRole("log")).toContainText("哈a");
  await expect(
    page.getByRole("button", { name: "冻结显示", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("loopback-after-gap.png"),
  });
});

test("uses the same deliberate mouse hover delay for window and session controls", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { theme: "light", motion: "reduced" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();

  for (const [name, hint] of [
    ["Minimize", "Minimize"],
    ["Maximize", "Maximize"],
    ["Close session", "Disconnect"],
  ]) {
    await page.mouse.move(1, 1);
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
    const button = page.getByRole("button", { name, exact: true });
    await button.hover();
    // 鼠标提示不能沿用原先不一致的 200/650/750 毫秒延时。
    await page.waitForTimeout(800);
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(tooltip).toBeVisible({ timeout: 1500 });
    await expect(tooltip).toHaveText(hint!);
    const alpha = await tooltip.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha).toBe(255);
  }
});

test("keeps controls and rapid editing responsive with a dense receive history", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await seedWorkbenchFixture(page, { theme: "dark", backgroundIntensity: 70 });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const sample = workbenchStreamItems()[2]!;
  if (sample.kind !== "source" || sample.event.kind !== "rx")
    throw new Error("RX fixture unavailable");
  const rx = sample.event;
  let previous = 0;
  const events: StreamItem[] = Array.from({ length: 512 }, (_, index) => {
    const value = "Received data ".repeat(60) + `TAIL-${index}\n`;
    const start = previous;
    previous += value.length;
    return {
      kind: "source",
      event: {
        ...rx,
        eventSeq: String(index + 1),
        time: { ...rx.time, sourceMonoNs: String(index + 1) },
        payload: {
          bytesBase64: Buffer.from(value).toString("base64"),
          byteStart: String(start),
          byteEnd: String(previous),
        },
      },
    };
  });
  for (let offset = 0; offset < events.length; offset += 16) {
    const batch: unknown[] = events.slice(offset, offset + 16);
    await page.evaluate(
      (items) => window.workbenchFixture.emitRaw(items),
      batch,
    );
  }
  const log = page.getByRole("log");
  await expect(
    page.getByRole("button", { name: "Freeze", exact: true }),
  ).toBeVisible();
  await expect(log).toContainText("TAIL-511");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await draft.fill("prefix");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  const frames = page.evaluate(async () => {
    const started = performance.now();
    const samples: {
      elapsedMs: number;
      sendDisabled: boolean;
      closeDisabled: boolean;
    }[] = [];
    while (performance.now() - started < 2500) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      samples.push({
        elapsedMs: performance.now() - started,
        sendDisabled:
          document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
            ?.disabled ?? true,
        closeDisabled:
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="Close session"]',
          )?.disabled ?? true,
      });
    }
    return samples;
  });
  const editingStarted = performance.now();
  await draft.pressSequentially("abcdefghijklmnopqrstuvwxyz0123456789", {
    delay: 0,
  });
  for (let index = 0; index < 36; index++) await draft.press("Backspace");
  const editingMs = performance.now() - editingStarted;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const samples = await frames;
  await expect(draft).toHaveValue("prefix");
  const editingEvidence = testInfo.outputPath("dense-editing-frames.json");
  await writeFile(
    editingEvidence,
    JSON.stringify(
      {
        samples,
        editingMs,
        scope:
          "Headless browser fixture, 512 RX blocks; continuous nonempty edit/delete and focus; no actual hardware",
      },
      null,
      2,
    ),
  );
  await testInfo.attach("dense-editing-frames", {
    path: editingEvidence,
    contentType: "application/json",
  });
  expect(samples.length).toBeGreaterThan(5);
  expect(
    samples.filter((sample) => sample.sendDisabled || sample.closeDisabled),
  ).toEqual([]);
  await log.hover();
  await page.mouse.wheel(0, -1000000);
  await expect(
    page.getByRole("button", { name: "Return to latest", exact: true }),
  ).toBeVisible();
  await expect(log).toContainText("TAIL-0");
  const scrolling = await log.evaluate(async (element) => {
    const times: number[] = [];
    for (let step = 0; step < 60; step++) {
      element.scrollTop =
        (step / 59) * (element.scrollHeight - element.clientHeight);
      times.push(
        await new Promise<number>((resolve) => requestAnimationFrame(resolve)),
      );
    }
    return times.slice(1).map((time, index) => time - times[index]!);
  });
  const scrollingEvidence = testInfo.outputPath("dense-scroll-frames.json");
  await writeFile(scrollingEvidence, JSON.stringify(scrolling));
  await testInfo.attach("dense-scroll-frames", {
    path: scrollingEvidence,
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("dense-receive-surface.png"),
  });
});

test("shows local millisecond times and compact totals while sending exactly ten thousand bytes", async ({
  page,
}, testInfo) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const items: unknown[] = workbenchStreamItems();
  await page.evaluate((items) => window.workbenchFixture.emitRaw(items), items);
  await expect(page.locator("time.workbench-stream-time").first()).toHaveText(
    "2026-11-10 19:22:33.456",
  );
  await expect(
    page.locator("time.workbench-stream-time").first(),
  ).toHaveAttribute("datetime", "2026-11-10T11:22:33.456Z");
  await expect(page.getByRole("log")).not.toContainText("host_read");
  await expect(page.getByRole("log")).not.toContainText("Accepted by backend");
  await expect(
    page.getByRole("group", {
      name: "Displayed confirmed TX bytes",
      exact: true,
    }),
  ).toHaveText("7 B");
  await expect(
    page.getByRole("group", { name: "Displayed RX bytes", exact: true }),
  ).toHaveText("4 B");
  const frame = await page.locator(".workbench-receive-frame").boundingBox();
  const totals = await page.locator(".workbench-stream-totals").boundingBox();
  if (!frame || !totals) throw new Error("Receive frame geometry unavailable");
  expect(totals.x).toBeGreaterThanOrEqual(frame.x);
  expect(totals.y).toBeGreaterThan(frame.y);
  expect(totals.x + totals.width).toBeLessThanOrEqual(
    frame.x + frame.width + 1,
  );
  expect(totals.y + totals.height).toBeLessThanOrEqual(
    frame.y + frame.height + 1,
  );
  const payload = "1234567890".repeat(1000);
  await page
    .getByRole("textbox", { name: "Send draft", exact: true })
    .fill(payload);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([Buffer.from(payload).toString("base64")]);
  await page.screenshot({
    path: testInfo.outputPath("local-time-and-inside-totals.png"),
  });
});

test("keeps large Chinese draft editing and local controls responsive before and after a Host fault", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await seedWorkbenchFixture(page, { theme: "dark", backgroundIntensity: 70 });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBeGreaterThan(0);
  const payload = "测".repeat(3333) + "a";
  const sample = workbenchStreamItems()[2]!;
  if (sample.kind !== "source" || sample.event.kind !== "rx")
    throw new Error("RX fixture unavailable");
  const items: unknown[] = [
    {
      kind: "source",
      event: {
        ...sample.event,
        eventSeq: "1",
        payload: {
          byteStart: "0",
          byteEnd: "10000",
          bytesBase64: Buffer.from(payload).toString("base64"),
        },
      },
    },
  ];
  await page.evaluate((items) => window.workbenchFixture.emitRaw(items), items);
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const evidence: {
    stage: string;
    frameGapsMs: number[];
    editingMs: number;
  }[] = [];
  for (const stage of ["connected", "after-host-fault"]) {
    if (stage === "after-host-fault") {
      expect(
        await page.evaluate(() => window.workbenchFixture.failHost()),
      ).toBeGreaterThan(0);
      await expect(
        page.getByRole("button", { name: "Send", exact: true }),
      ).toBeDisabled();
    }
    const frames = page.evaluate(async () => {
      const times: number[] = [];
      const started = performance.now();
      while (performance.now() - started < 1800)
        times.push(
          await new Promise<number>((resolve) =>
            requestAnimationFrame(resolve),
          ),
        );
      return times.slice(1).map((value, index) => value - times[index]!);
    });
    const started = performance.now();
    await draft.fill(payload);
    await draft.pressSequentially("连续输入测试", { delay: 0 });
    for (let index = 0; index < 6; index++) await draft.press("Backspace");
    await expect(draft).toHaveValue(payload);
    const editingMs = performance.now() - started;
    for (let index = 0; index < 4; index++)
      await page
        .getByRole("button", { name: "Toggle theme", exact: true })
        .click();
    const gaps = await frames;
    evidence.push({ stage, frameGapsMs: gaps, editingMs });
    expect(gaps.length).toBeGreaterThan(20);
    const ordered = [...gaps].sort((a, b) => a - b);
    expect(ordered[Math.ceil(ordered.length * 0.95) - 1]).toBeLessThan(100);
    expect(Math.max(...gaps)).toBeLessThan(500);
  }
  await draft.fill("");
  await page
    .locator(".app-sidebar-tools")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(page.locator("#settings-theme")).toBeVisible();
  await page.getByRole("button", { name: "Minimize", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Minimize", {
    timeout: 2000,
  });
  const path = testInfo.outputPath("large-chinese-fault-frames.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        scope:
          "Headless browser fixture; 10000 UTF-8 bytes; local editing/theme/settings/tooltip after an injected Host fault; no hardware or native-window performance claim",
        evidence,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("large-chinese-fault-frames", {
    path,
    contentType: "application/json",
  });
});
