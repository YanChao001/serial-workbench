import { expect, test } from "@playwright/test";
import { session } from "../../src/features/workbench/test-fixtures";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("broadcast confirms one payload for two ports and restores their independent receipts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await seedWorkbenchFixture(page, {
    manualSendReceipts: true,
    secondDevice: {
      deviceId: "peer-device",
      hostId: "workbench-gui-host",
      systemName: "Peer serial",
      fingerprint: { transport: "virtual", evidence: "unreliable" },
      capabilities: session().capabilities,
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Choose device", exact: true })
    .click();
  await page.getByRole("option", { name: "Peer serial" }).click();
  await page
    .getByRole("button", { name: "Open Peer serial", exact: true })
    .click();

  async function openBroadcast() {
    await page
      .getByRole("button", { name: "Workspace menu", exact: true })
      .press("ArrowDown");
    await page
      .getByRole("menuitem", { name: "Multi-port broadcast", exact: true })
      .click();
    return page.getByRole("dialog", {
      name: "Multi-port broadcast",
      exact: true,
    });
  }

  const panel = await openBroadcast();
  const first = panel.getByRole("checkbox", { name: /Virtual serial/ });
  const second = panel.getByRole("checkbox", { name: /Peer serial/ });
  const editor = panel.getByRole("textbox", {
    name: "Final bytes (HEX)",
    exact: true,
  });
  const confirm = panel.getByRole("button", {
    name: "Confirm and send in parallel",
  });
  const wideTarget = await first.boundingBox();
  const wideEditor = await editor.boundingBox();
  if (!wideTarget || !wideEditor)
    throw new Error("Missing wide broadcast form bounds");
  expect(wideEditor.x).toBeGreaterThan(wideTarget.x + wideTarget.width);
  await first.check();
  await editor.fill("00 FF");
  await expect(confirm).toBeDisabled();
  await second.check();
  await expect(panel.getByText("2 bytes per port · 2 selected")).toBeVisible();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await page.setViewportSize({ width: 440, height: 660 });
  const narrowTarget = await second.boundingBox();
  const narrowEditor = await editor.boundingBox();
  if (!narrowTarget || !narrowEditor)
    throw new Error("Missing narrow broadcast form bounds");
  expect(narrowEditor.y).toBeGreaterThan(narrowTarget.y + narrowTarget.height);
  await confirm.click();

  const receipts = panel.getByRole("region", { name: "Per-port results" });
  await expect(
    receipts.getByText("2 bytes accepted · 0 bytes unconfirmed"),
  ).toHaveCount(2);
  const calls = await page.evaluate(() =>
    window.workbenchFixture.invocations.filter(
      (item) => item.actionId === "session.tx",
    ),
  );
  expect(calls.map(({ target }) => target.sessionId).sort()).toEqual([
    "second-session",
    "session",
  ]);
  expect(
    calls.every(
      (call) =>
        call.params.bytesBase64 === "AP8=" &&
        call.executionMode === "independent",
    ),
  ).toBe(true);
  await receipts.screenshot({
    path: info.outputPath("broadcast-receipts-narrow.png"),
  });

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await openBroadcast();
  await expect(
    receipts.getByText("2 bytes accepted · 0 bytes unconfirmed"),
  ).toHaveCount(2);
  expect(
    await page.evaluate(() => window.workbenchFixture.sentBytes),
  ).toHaveLength(2);
});
