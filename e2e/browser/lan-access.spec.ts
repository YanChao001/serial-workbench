import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { ActivitySummary } from "@serial-workbench/contracts";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("desktop LAN sharing manages a peer without showing fingerprints", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 780 });
  await seedWorkbenchFixture(page, { language: "en", theme: "dark" });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close session", exact: true }),
  ).toBeEnabled();
  await page.goto("./#/settings?focus=lanAccess");
  const manage = page.getByRole("button", { name: "Manage sharing" });
  await manage.click();
  const panel = page.getByRole("dialog", { name: "LAN sharing" });
  await panel
    .getByRole("button", { name: "Copy this computer’s pairing information" })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Pairing information copied",
  );
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.copiedLanInfo))
    .toEqual([
      JSON.stringify({
        hostId: "workbench-gui-host",
        fingerprint: "a".repeat(64),
      }),
    ]);
  const peer = { hostId: "paired-owner", fingerprint: "b".repeat(64) };
  await panel
    .getByLabel("Paste the other computer’s pairing information")
    .fill(JSON.stringify(peer));
  const serial = panel.getByRole("combobox", { name: "Virtual serial" });
  await serial.click();
  await page.getByRole("option", { name: "View only" }).click();
  await panel.getByRole("button", { name: "Trust and pair" }).click();
  await expect(panel.getByText("Paired with this computer")).toBeVisible();
  await expect(
    panel.getByLabel("Paste the other computer’s pairing information"),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Change peer" }),
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.lanCommands.find(
          (command) => command.kind === "setShares",
        ),
      ),
    )
    .toEqual({
      kind: "setShares",
      peer,
      shares: [
        {
          target: {
            hostId: "workbench-gui-host",
            kind: "session",
            id: "session",
            sessionId: "session",
            sessionEpoch: "1",
          },
          access: "readOnly",
        },
      ],
    });
  await panel.getByLabel("Local listen address").fill("127.0.0.1:8022");
  await panel.getByRole("button", { name: "Allow LAN connections" }).click();
  await expect(panel.getByText("Listening on 127.0.0.1:8022")).toBeVisible();
  await expect(panel.getByText(peer.fingerprint)).toHaveCount(0);
  await expect(panel.getByText("a".repeat(64))).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("desktop-lan-sharing.png") });
  await panel.getByRole("button", { name: "Stop listening" }).click();
  await expect(panel.getByRole("button", { name: "Unpair" })).toBeEnabled();
  await panel.getByRole("button", { name: "Unpair" }).click();
  const pairingInput = panel.getByLabel(
    "Paste the other computer’s pairing information",
  );
  await expect(pairingInput).toHaveValue("");
  await expect(pairingInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(manage).toBeFocused();
});

test("desktop workbench opens a shared serial view and keeps local drafts and settings", async ({
  page,
}, info) => {
  const owner = { hostId: "paired-owner", address: "192.168.1.8:8022" };
  await seedWorkbenchFixture(page, { lanOwner: owner, theme: "dark" });
  await page.goto("./#/");
  const localOpen = page.getByRole("button", {
    name: "Open Virtual serial",
    exact: true,
  });
  await expect(localOpen).toBeEnabled();
  const menu = page.getByRole("button", { name: "Workspace menu" });
  async function connectionPanel() {
    await menu.click();
    await page.getByRole("menuitem", { name: "LAN connection" }).click();
    return page.getByRole("dialog", { name: "LAN connection" });
  }
  let panel = await connectionPanel();
  const fingerprint = "b".repeat(64);
  await panel
    .getByLabel("Connection information")
    .fill(JSON.stringify({ ...owner, fingerprint }));
  const address = panel.getByLabel("Other computer’s address");
  await expect(address).toHaveValue(owner.address);
  await expect(address).toBeFocused();
  await expect(panel.getByText(fingerprint)).toHaveCount(0);
  await address.fill("192.168.1.9:8022");
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("could not be reached");
  await address.fill(owner.address);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const sharedOpen = page.getByRole("button", {
    name: "Open Shared UART",
    exact: true,
  });
  await expect(sharedOpen).toBeEnabled();
  await sharedOpen.click();
  await expect(
    page.getByRole("tab", { name: "Shared UART", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("LAN", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const rx = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (!rx || rx.kind !== "source" || rx.event.kind !== "rx")
    throw new Error("Missing RX fixture");
  const event = {
    ...rx.event,
    hostId: owner.hostId,
    sessionId: "shared-session",
  };
  expect(
    await page.evaluate(
      (item: unknown) => window.workbenchFixture.emitRaw([item]),
      { kind: "source", event },
    ),
  ).toBe(1);
  await expect(
    page.getByRole("log", { name: "Receive", exact: true }),
  ).toContainText("OK");
  await page.screenshot({
    path: info.outputPath("desktop-shared-workbench.png"),
  });

  await menu.click();
  await page.getByRole("menuitem", { name: "Close all views" }).click();
  const sharedTab = page.getByRole("tab", { name: "Shared UART", exact: true });
  await expect(sharedTab).toHaveCount(0);
  const named: ActivitySummary = {
    activityId: "first-shared-activity",
    actorId: "forwarded-bench-assistant",
    mcpClientId: "bench-assistant",
    requestId: randomUUID(),
    operationId: "shared-send",
    actionId: "session.tx",
    target: {
      hostId: owner.hostId,
      kind: "session",
      id: "shared-session",
      sessionId: "shared-session",
      sessionEpoch: "1",
    },
    revealTarget: {
      pageId: "workbench",
      panelId: "send",
      sessionId: "shared-session",
    },
    observations: "1",
    observedAt: "2026-11-21T03:00:00Z",
  };
  async function publish(items: ActivitySummary[]) {
    expect(
      await page.evaluate(
        (entries: unknown[]) =>
          window.workbenchFixture.emitSharedActivity(entries),
        items,
      ),
    ).toBe(1);
  }
  await publish([named]);
  const activityButton = page.getByRole("button", {
    name: "Activity",
    exact: true,
  });
  await activityButton.click();
  const activity = page.getByRole("dialog", { name: "Activity", exact: true });
  await activity.getByRole("combobox", { name: "AI client to follow" }).click();
  await page.getByRole("option", { name: "bench-assistant" }).click();
  await expect(
    activity.getByRole("button", { name: "Locate", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sharedTab).toHaveAttribute("aria-selected", "true");
  const draft = page.getByRole("textbox", { name: "Send draft", exact: true });
  await draft.focus();
  await publish([
    named,
    {
      ...named,
      activityId: "second-shared-activity",
      requestId: randomUUID(),
      operationId: "shared-configure",
      actionId: "session.configure",
      revealTarget: { ...named.revealTarget, panelId: "parameters" },
    },
  ]);
  const parameters = page.getByRole("dialog", {
    name: "Connection parameters",
  });
  await expect(draft).toBeFocused();
  await expect(parameters).toBeHidden();
  await activityButton.focus();
  await expect(parameters).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-lan-mcp-follow.png"),
  });
  await page.keyboard.press("Escape");

  await draft.fill("draft for the shared port");
  panel = await connectionPanel();
  await panel.getByRole("button", { name: "Return to this computer" }).click();
  const unsaved = page.getByRole("dialog", { name: "Save unfinished work" });
  await expect(unsaved).toBeVisible();
  await unsaved
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await expect(localOpen).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(
          window.workbenchFixture.clientStateWrites.at(-1)?.drafts ?? {},
        ),
      ),
    )
    .toContain("draft for the shared port");
  const ownership = await page.evaluate(() => ({
    remoteEnumeration: window.workbenchFixture.queryInputs.filter(
      ({ actionId, hostId }) =>
        hostId === "paired-owner" &&
        ["device.refresh", "settings.read", "workspace.read"].includes(
          actionId,
        ),
    ),
    localSettings: window.workbenchFixture.queryInputs.some(
      ({ actionId, hostId }) =>
        actionId === "settings.read" && hostId === "workbench-gui-host",
    ),
    switches: window.workbenchFixture.lanSwitches,
  }));
  expect(ownership.remoteEnumeration).toEqual([]);
  expect(ownership.localSettings).toBe(true);
  expect(ownership.switches).toEqual([
    { generation: "1", route: { ...owner, address: "192.168.1.9:8022" } },
    { generation: "1", route: owner },
    { generation: "2", route: null },
  ]);
  panel = await connectionPanel();
  await expect(panel.getByLabel("Other computer’s address")).toHaveValue(
    owner.address,
  );
});
