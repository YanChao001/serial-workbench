import { expect, test, type Page } from "@playwright/test";
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import { session } from "../../src/features/workbench/test-fixtures";
import { builtinAutomation } from "./json-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

const actionId = "swb.builtin.automation.loopback";
const spec = builtinAutomation.contributes.actions.find(
  (entry) => entry.actionId === actionId,
);
if (!validateActionSpec(spec))
  throw new Error("Missing signed loopback action");
const capabilities = session().capabilities;

async function openLoopback(page: Page, title: string) {
  const menu = page.getByRole("button", {
    name: /^(Workspace menu|工作区菜单)$/,
  });
  await menu.press("ArrowDown");
  await page.getByRole("menuitem", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, menu };
}

const starts = (page: Page) =>
  page.evaluate(
    (id) =>
      window.workbenchFixture.invocations.filter(
        (call) => call.actionId === id,
      ),
    actionId,
  );

test("virtual loopback uses shared wide form and renders scoped real-result fields", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 760 });
  await seedWorkbenchFixture(page, {
    device: {
      deviceId: "virtual:echo",
      systemName: "Virtual Echo",
      hostId: "workbench-gui-host",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities,
    },
    automation: { action: spec, state: "ready" },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual Echo", exact: true })
    .click();
  const { dialog, menu } = await openLoopback(page, "Loopback self-test");
  await expect(
    dialog.getByText("Virtual Echo · Virtual loopback"),
  ).toBeVisible();
  const size = dialog.getByRole("spinbutton", { name: "Bytes per frame" });
  const count = dialog.getByRole("spinbutton", { name: "Frame count" });
  await expect(size).toBeFocused();
  expect((await size.boundingBox())?.height).toBe(
    (await count.boundingBox())?.height,
  );
  expect((await size.boundingBox())?.y).toBe((await count.boundingBox())?.y);
  await size.press("Enter");
  expect(await starts(page)).toHaveLength(0);
  await size.fill("10");
  const start = dialog.getByRole("button", { name: "Run self-test" });
  await expect(start).toBeDisabled();
  await size.fill("64");
  await expect(dialog.getByText("The test will send 256 B.")).toBeVisible();
  await start.click();
  await expect(dialog.getByText("Loopback measurement complete")).toBeVisible();
  await expect(dialog.getByText("0 / 1,536")).toBeVisible();
  await expect(dialog.getByText("12,800 B/s")).toBeVisible();
  await expect(dialog.getByText("5 ms")).toBeVisible();
  await dialog.getByText("Show frame details").click();
  await expect(
    dialog.getByText("RX bytes [10, 74)", { exact: false }),
  ).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("loopback-wide.png") });
  expect(await starts(page)).toEqual([
    expect.objectContaining({
      executionMode: "independent",
      params: expect.objectContaining({
        source: "virtual_echo",
        frameBytes: 64,
        count: 4,
        wired: false,
        configurationRevision: "1",
        sessionRevision: "1",
      }),
    }),
  ]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});

test("short physical-port tool requires wiring and waits for cancelled terminal state", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 460 });
  const name = "COM7 USB UART Engineering Bench";
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    device: {
      deviceId: "device",
      hostId: "workbench-gui-host",
      systemName: name,
      fingerprint: { transport: "serial", evidence: "unreliable" },
      capabilities,
    },
    automation: { action: spec, state: "held" },
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "打开 " + name, exact: true }).click();
  const { dialog } = await openLoopback(page, "环回自检");
  const start = dialog.getByRole("button", { name: "启动自检" });
  const confirmation = dialog.getByRole("checkbox", { name: /已短接/ });
  await expect(start).toBeDisabled();
  expect(await starts(page)).toHaveLength(0);
  await confirmation.check();
  await expect(start).toBeInViewport();
  await dialog.screenshot({ path: info.outputPath("loopback-narrow.png") });
  await start.click();
  await expect(dialog.getByText(/运行中，已比较/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openLoopback(page, "环回自检");
  await dialog.getByRole("button", { name: "停止", exact: true }).click();
  await expect(dialog.getByText("等待任务停止。")).toBeVisible();
  await expect(dialog.getByText("环回自检已取消。")).toBeHidden();
  await page.evaluate(() =>
    window.workbenchFixture.finishAutomationCancellation(),
  );
  await expect(dialog.getByText("环回自检已取消。")).toBeVisible();
  expect(await starts(page)).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        source: "serial_loopback",
        wired: true,
      }),
    }),
  ]);
});
