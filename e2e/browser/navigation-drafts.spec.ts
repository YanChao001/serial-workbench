import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("a connected view and its unsaved draft survive settings navigation without remounting", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { drafts: { unconnected: "SAVED DRAFT" } });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  const close = page.getByRole("button", {
    name: "Close session",
    exact: true,
  });
  await expect(close).toBeEnabled();
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await draft.fill("UNSAVED CONNECTED DRAFT");
  const original = await draft.elementHandle();
  const tabs = await page.getByRole("tab").allTextContents();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const readers = await page.evaluate(
    () => window.workbenchFixture.rawSubscriptions,
  );
  await page
    .locator(".app-sidebar-tools")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(page.locator("#settings-theme")).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.rawSubscriptions),
  ).toEqual(readers);
  const source = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (!source || source.kind !== "source" || source.event.kind !== "rx")
    throw new Error("RX fixture missing");
  const text = "RECEIVED_WHILE_SETTINGS";
  const received = {
    kind: "source",
    event: {
      ...source.event,
      eventSeq: "1000",
      payload: {
        ...source.event.payload,
        bytesBase64: Buffer.from(text).toString("base64"),
        byteStart: "4",
        byteEnd: String(4 + text.length),
      },
    },
  };
  expect(
    await page.evaluate(
      (item) => window.workbenchFixture.emitRaw([item]),
      received,
    ),
  ).toBe(1);
  await page.locator('#app-sidebar-navigation a[href="#/"]').click();
  await expect(close).toBeEnabled();
  await expect(draft).toHaveValue("UNSAVED CONNECTED DRAFT");
  await expect(page.getByRole("log")).toContainText(text);
  expect(
    await draft.evaluate((element, previous) => element === previous, original),
  ).toBe(true);
  expect(await page.getByRole("tab").allTextContents()).toEqual(tabs);
  expect(
    await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
  ).toEqual([]);
});

test("repeated settings, theme and dialog changes retain drafts across navigation and refresh", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedWorkbenchFixture(page, {
    theme: "light",
    drafts: { unconnected: "SAVED DRAFT" },
  });
  await page.goto("./#/");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  const settings = page.locator(".app-sidebar-tools").getByRole("link", {
    name: "Settings",
    exact: true,
  });
  const workbench = page.locator('#app-sidebar-navigation a[href="#/"]');
  const workspace = page.getByRole("button", {
    name: "Workspace",
    exact: true,
  });
  for (let cycle = 0; cycle < 6; cycle++) {
    await expect(draft).toHaveValue("SAVED DRAFT");
    await settings.click();
    const theme = cycle % 2 === 0 ? "Dark" : "Light";
    await page
      .locator("#settings-theme")
      .getByRole("button", { name: theme, exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.workbenchFixture.settingsWrites.at(-1)?.theme,
        ),
      )
      .toBe(theme.toLowerCase());
    await workbench.click();
    await expect(draft).toHaveValue("SAVED DRAFT");
    await expect(
      page.getByRole("button", { name: "Open Virtual serial", exact: true }),
    ).toBeEnabled();
    await workspace.click();
    const dialog = page.getByRole("dialog", { name: "Workspace", exact: true });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close view", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(workspace).toBeFocused();
    if (cycle % 3 === 2) {
      await page.reload();
      await expect(draft).toHaveValue("SAVED DRAFT");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(theme === "Dark");
    }
    expect(
      await page.evaluate(() => window.workbenchFixture.unexpectedCommands),
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("returning to the workbench reuses restored drafts without a loading flash", async ({
  page,
}, testInfo) => {
  await seedWorkbenchFixture(page, { drafts: { unconnected: "SAVED DRAFT" } });
  await page.goto("./#/");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await expect(draft).toHaveValue("SAVED DRAFT");
  const settings = page.locator(".app-sidebar-tools").getByRole("link", {
    name: "Settings",
    exact: true,
  });
  const workbench = page.locator('#app-sidebar-navigation a[href="#/"]');
  // 首次设置模块加载不混入后续切换的测量。
  await settings.click();
  await expect(page.locator("#settings-theme")).toBeVisible();
  const samples: { returnMs: number; reads: number; loadingFlashes: number }[] =
    [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const probe = await page.evaluateHandle(() => {
      const state = { loadingFlashes: 0 };
      let recovering = false;
      const observer = new MutationObserver(() => {
        const next = Boolean(
          document.querySelector(
            '[data-testid="serial-workbench-shell"] > [aria-busy="true"]',
          ),
        );
        if (next && !recovering) state.loadingFlashes++;
        recovering = next;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return {
        state,
        reads: window.workbenchFixture.clientStateReads,
        started: performance.now(),
        stop: () => observer.disconnect(),
      };
    });
    // 保留观察器句柄于页面侧，读取该次切换的结果后释放。
    await workbench.click();
    await expect(draft).toHaveValue("SAVED DRAFT");
    samples.push(
      await probe.evaluate((probe) => {
        probe.stop();
        return {
          returnMs: performance.now() - probe.started,
          reads: window.workbenchFixture.clientStateReads - probe.reads,
          loadingFlashes: probe.state.loadingFlashes,
        };
      }),
    );
    await probe.dispose();
    await settings.click();
    await expect(page.locator("#settings-theme")).toBeVisible();
  }
  const evidence = testInfo.outputPath("navigation-drafts.json");
  await writeFile(
    evidence,
    JSON.stringify(
      {
        scope:
          "Headless browser fixture; three warm route cycles; returnMs includes automation overhead, not native-window latency",
        samples,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("navigation-drafts", {
    path: evidence,
    contentType: "application/json",
  });
  expect(samples.map((sample) => sample.reads)).toEqual([0, 0, 0]);
  expect(samples.map((sample) => sample.loadingFlashes)).toEqual([0, 0, 0]);
});
