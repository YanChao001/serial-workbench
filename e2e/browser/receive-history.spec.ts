/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

async function choose(page: Page, name: string, value: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
function packets(
  start: number,
  count: number,
  bytesPerPacket = 12,
  byteStart = (start - 1) * bytesPerPacket,
): unknown[] {
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing RX fixture");
  return Array.from({ length: count }, (_, offset) => {
    const sequence = start + offset;
    return {
      kind: "source",
      event: {
        ...source.event,
        kind: "rx",
        eventSeq: String(sequence + 10),
        time: {
          ...source.event.time,
          sourceMonoNs: String(sequence * 200_000_000),
        },
        payload: {
          bytesBase64: Buffer.from(
            `packet-${String(sequence).padStart(4, "0")}\n`.padEnd(
              bytesPerPacket,
              "0",
            ),
          ).toString("base64"),
          byteStart: String(byteStart + offset * bytesPerPacket),
          byteEnd: String(byteStart + (offset + 1) * bytesPerPacket),
        },
      },
    };
  });
}

test("small upward scrolling keeps the latest button available throughout history review", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    packets(1, 40),
  );
  const log = page.getByRole("log");
  await expect(log).toContainText("packet-0040");
  await expect
    .poll(() =>
      log.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  const latest = page.getByRole("button", {
    name: en["workbench.returnToLatest"],
    exact: true,
  });
  await log.hover();
  const endTop = await log.evaluate((element) => element.scrollTop);
  for (const delta of [-8, -8, -12, -32]) {
    const previousTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, delta);
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(previousTop - 4);
    await expect(latest).toBeVisible();
  }
  expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(
    endTop - 40,
  );
  await log.press("Control+End");
  await expect(latest).toBeHidden();
});

for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 720, height: 600 },
] as const)
  test(`reviewing receive history stays live and pending data is explained in the totals (${sample.language})`, async ({
    page,
  }, info) => {
    const words = sample.language === "zh" ? zhCN : en;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, { ...sample, sidebarCollapsed: true });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBe(1);
    const log = page.getByRole("log");
    const footer = page.locator(".workbench-stream-totals");
    const footerHeight = (await footer.boundingBox())!.height;
    for (let start = 1; start <= 40; start += 10) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(start, 10),
      );
      await expect(log).toContainText(
        `packet-${String(start + 9).padStart(4, "0")}`,
      );
      await expect
        .poll(() =>
          log.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(24);
    }
    await log.hover();
    const endTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, -180);
    const latest = footer.getByRole("button", {
      name: words["workbench.returnToLatest"],
      exact: true,
    });
    await expect(latest).toBeVisible();
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(endTop - 100);
    const previousTop = await log.evaluate((element) => element.scrollTop);
    for (let start = 41; start <= 60; start += 10) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(start, 10),
      );
      await expect(log).toContainText(
        `packet-${String(start + 9).padStart(4, "0")}`,
      );
    }
    await expect(
      page.getByRole("button", {
        name: words["workbench.freeze"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: words["workbench.resume"],
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(footer).toContainText(
      words["workbench.newUpdates"].replace("{count}", "20"),
    );
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    await expect(latest).toHaveText(
      words["workbench.newUpdates"].replace("{count}", "20"),
    );
    expect(
      Math.abs(
        (await log.evaluate((element) => element.scrollTop)) - previousTop,
      ),
    ).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath("viewing-history.png") });
    await latest.click();
    await expect(latest).toBeHidden();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(24);

    // Reaching the end by native scrolling also restores following.
    await log.hover();
    await page.mouse.wheel(0, -180);
    await expect(latest).toBeVisible();
    await log.press("Control+End");
    await expect(latest).toBeHidden();
    await page
      .getByRole("button", { name: words["workbench.freeze"], exact: true })
      .click();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(61, 7),
    );
    await expect(log).not.toContainText("packet-0067");
    await expect(footer).toContainText(words["workbench.displayPaused"]);
    await expect(footer).toContainText(
      words["workbench.pendingUpdates"].replace("{count}", "7"),
    );
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    await expect(page.getByText("+7", { exact: true })).toHaveCount(0);
    expect(
      await footer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("paused-display-footer.png"),
    });
    await page
      .getByRole("button", { name: words["workbench.resume"], exact: true })
      .click();
    await expect(log).toContainText("packet-0067");
    await expect(footer).not.toContainText(words["workbench.displayPaused"]);
    // Large, wrapped rows settle their browser layout after the initial append.
    // Both live following and reading history must survive those later resizes.
    for (let sequence = 68; sequence <= 70; sequence++) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(sequence, 1, 16384, 804 + (sequence - 68) * 16384),
      );
      await expect(log).toContainText(
        `packet-${String(sequence).padStart(4, "0")}`,
      );
      await expect
        .poll(() =>
          log.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(24);
    }
    await log.hover();
    const largeEndTop = await log.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, -240);
    await expect(latest).toBeVisible();
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeLessThan(largeEndTop - 120);
    const largeTop = await log.evaluate((element) => element.scrollTop);
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(71, 1, 16384, 804 + 3 * 16384),
    );
    await expect(log).toContainText("packet-0071");
    await expect(
      page.getByRole("button", {
        name: words["workbench.freeze"],
        exact: true,
      }),
    ).toBeVisible();
    expect(
      Math.abs((await log.evaluate((element) => element.scrollTop)) - largeTop),
    ).toBeLessThanOrEqual(2);
    await latest.click();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(24);
    const options = page.getByRole("button", {
      name: words["workbench.tools.displayOptions"],
      exact: true,
    });
    await options.click();
    await choose(page, words["workbench.historyRecords"], "10");
    await options.click();
    await log.hover();
    await page.mouse.wheel(0, -40);
    await expect(latest).toBeVisible();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(72, 2, 12, 804 + 4 * 16384),
    );
    await expect(latest).toHaveText(
      words["workbench.newUpdates"].replace("{count}", "2"),
    );
    await expect(
      footer.getByText(words["workbench.historyTrimmed"], { exact: true }),
    ).toBeVisible();
    expect((await footer.boundingBox())!.height).toBe(footerHeight);
    expect(
      await footer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const spacing = await page.locator(".workbench").evaluate((root) => {
      const rect = (selector: string) => {
        const element = root.querySelector(selector);
        if (!element)
          throw new Error(`Missing receive spacing region ${selector}`);
        return element.getBoundingClientRect();
      };
      const row = rect(".workbench-stream-row:last-child");
      const time = rect(".workbench-stream-row:last-child time");
      const message = rect(
        ".workbench-stream-row:last-child .workbench-stream-content",
      );
      const bytes = rect(
        ".workbench-stream-row:last-child .workbench-stream-meta > span",
      );
      const receive = rect(".workbench-receive-frame");
      const receivedBytes = rect(".workbench-stream-totals > span:last-child");
      const draft = rect(".workbench-draft-frame");
      const draftBytes = rect(".workbench-draft-bytes");
      return {
        timestampInset: row.bottom - time.bottom,
        receiveInset: receive.bottom - receivedBytes.bottom,
        draftInset: draft.bottom - draftBytes.bottom,
        messageGap: time.top - message.bottom,
        byteGap: bytes.left - time.right,
        receiveFooterHeight: rect(".workbench-stream-totals").height,
        draftFooterHeight: draft.bottom - rect(".workbench-draft").bottom,
      };
    });
    await info.attach("receive-spacing", {
      body: JSON.stringify(spacing),
      contentType: "application/json",
    });
    expect(
      Math.abs(spacing.timestampInset - spacing.draftInset),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(spacing.receiveInset - spacing.draftInset),
    ).toBeLessThanOrEqual(0.5);
    expect(Math.abs(spacing.messageGap - spacing.byteGap)).toBeLessThanOrEqual(
      0.5,
    );
    expect(spacing.receiveFooterHeight).toBe(spacing.draftFooterHeight);
    await page.screenshot({
      path: info.outputPath("compact-history-footer.png"),
    });
    expect(errors).toEqual([]);
  });

test("a fragmented continuous burst stays complete below the data budget and clears by byte boundary", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { sidebarCollapsed: true });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (source?.kind !== "source") throw new Error("Missing source");
  const fragment = (index: number) => ({
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      eventSeq: String(index + 11),
      time: { ...source.event.time, sourceMonoNs: String(index * 1_000_000) },
      payload: {
        bytesBase64: Buffer.from("0123456789abcdef").toString("base64"),
        byteStart: String(index * 16),
        byteEnd: String((index + 1) * 16),
      },
    },
  });
  for (let index = 0; index < 5000; index += 100)
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      Array.from({ length: 100 }, (_, offset) => fragment(index + offset)),
    );
  const log = page.getByRole("log");
  await expect
    .poll(() =>
      log.evaluate(
        (element) =>
          Array.from(element.querySelectorAll(".workbench-payload"))
            .map((item) => item.textContent)
            .join("") === "0123456789abcdef".repeat(5000),
      ),
    )
    .toBe(true);
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(1);
  await expect(
    page.getByText(en["workbench.historyTrimmed"], { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: en["workbench.tools.clearView"], exact: true })
    .click();
  await expect(log.locator('[data-direction="rx"]')).toHaveCount(0);
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    [fragment(5000)],
  );
  await expect(log.locator(".workbench-payload")).toHaveText(
    "0123456789abcdef",
  );
  await expect(
    page.getByText(en["workbench.historyTrimmed"], { exact: true }),
  ).toHaveCount(0);
});

test("controls have a connected-only entry and leave the parameter dialog focused on configuration", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  const button = page.getByRole("button", {
    name: "控制线与回执",
    exact: true,
  });
  await expect(button).toBeDisabled();
  await page
    .getByRole("button", { name: "打开 Virtual serial", exact: true })
    .click();
  await expect(button).toBeEnabled();
  await page.getByRole("button", { name: "连接参数", exact: true }).click();
  const parameters = page.getByRole("dialog", {
    name: "连接参数",
    exact: true,
  });
  await expect(parameters.getByRole("tab")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.hostQueries.filter(
        (action) => action === "session.inputs",
      ),
    ),
  ).toHaveLength(0);
  await parameters.press("Escape");
  const controls = page.getByRole("dialog", {
    name: "控制线与回执",
    exact: true,
  });
  for (let index = 0; index < 6; index++) {
    await button.click();
    await expect(
      controls.getByRole("button", { name: "置位 DTR", exact: true }),
    ).toBeVisible();
    await controls.getByRole("tab", { name: /回执/ }).click();
    await controls.getByRole("tab", { name: "控制线", exact: true }).click();
    await controls.press("Escape");
    await expect(controls).toBeHidden();
  }
  await button.click();
  await controls.screenshot({
    path: info.outputPath("control-lines-and-receipts.png"),
  });
  await expect(
    page.getByText(zhCN["nativeError.hostBusy"], { exact: true }),
  ).toHaveCount(0);
});

for (const sample of [
  { language: "zh", theme: "dark", width: 1400, height: 925 },
  { language: "en", theme: "light", width: 880, height: 600 },
] as const)
  test(`receive retention saves and resizes live and paused data (${sample.language})`, async ({
    page,
  }, info) => {
    // 1500 条渲染、冻结、两次保留设置和重载共同验收，保留每步断言的原期限。
    test.setTimeout(60_000);
    const words = sample.language === "zh" ? zhCN : en;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await seedWorkbenchFixture(page, { ...sample, sidebarCollapsed: true });
    await page.goto("./#/");
    const options = page.getByRole("button", {
      name: words["workbench.tools.displayOptions"],
      exact: true,
    });
    await options.click();
    await choose(page, words["workbench.historyRecords"], "5,000");
    await choose(page, words["workbench.historyCapacity"], "4 MiB");
    await options.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.clientStateWrites.at(-1)?.preferences
              .receiveHistory,
        ),
      )
      .toEqual({ maxRecords: 5000, maxBytes: 4 * 1024 * 1024 });
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
      )
      .toBe(1);
    for (let first = 1; first <= 1500; first += 100) {
      await page.evaluate(
        (items: unknown[]) => window.workbenchFixture.emitRaw(items),
        packets(first, 100),
      );
    }
    const log = page.getByRole("log");
    await expect(log).toContainText("packet-0001");
    await expect(log).toContainText("packet-1500");
    await page
      .getByRole("button", { name: words["workbench.freeze"], exact: true })
      .click();
    await page.evaluate(
      (items: unknown[]) => window.workbenchFixture.emitRaw(items),
      packets(1501, 10),
    );
    await expect(log).not.toContainText("packet-1510");
    await options.click();
    await choose(page, words["workbench.historyRecords"], "100");
    await options.click();
    await expect(log).not.toContainText("packet-0001");
    await expect(log).toContainText("packet-1401");
    await expect(log).toContainText("packet-1500");
    await expect(log).not.toContainText("packet-1510");
    await expect(
      page.getByText(words["workbench.historyTrimmed"], { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(words["workbench.gapHelp"], { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: words["workbench.resume"], exact: true })
      .click();
    await expect(log).toContainText("packet-1411");
    await expect(log).toContainText("packet-1510");
    expect(
      await page.evaluate(
        () => window.workbenchFixture.rawSubscriptions.length,
      ),
    ).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.workbenchFixture.clientStateWrites.at(-1)?.preferences
              .receiveHistory?.maxRecords,
        ),
      )
      .toBe(100);
    await page.reload();
    await page
      .getByRole("button", {
        name: words["workbench.tools.displayOptions"],
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("combobox", { name: words["workbench.historyRecords"] }),
    ).toHaveText("100");
    await expect(
      page.getByRole("combobox", { name: words["workbench.historyCapacity"] }),
    ).toHaveText("4 MiB");
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("receive-retention-options.png"),
    });
  });
