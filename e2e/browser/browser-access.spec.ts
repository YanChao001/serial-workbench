import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("desktop settings lets a person pair and revoke browser access", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 420, height: 780 });
  await seedWorkbenchFixture(page, { language: "en", theme: "dark" });
  await page.goto("./#/settings?focus=browserAccess");
  const configure = page.getByRole("button", {
    name: "Configure browser access",
  });
  await configure.click();
  const dialog = page.getByRole("dialog", { name: "Browser access" });
  const mode = dialog.getByRole("combobox", { name: "Access level" });
  await expect(mode).toHaveText("View only");
  await mode.click();
  await page.getByRole("option", { name: "View and operate" }).click();
  const pair = dialog.getByRole("button", { name: "Generate pairing code" });
  await pair.click();
  await expect(
    dialog.getByRole("textbox", { name: "Pairing code" }),
  ).toHaveValue("a".repeat(43));
  await expect(
    dialog.getByRole("link", { name: "Open in browser" }),
  ).toHaveAttribute("href", "http://127.0.0.1:9240");
  await expect(dialog.getByText("browser-hidden-fixture")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("desktop-browser-pairing.png"),
  });

  await page.keyboard.press("Escape");
  await expect(configure).toBeFocused();
  await configure.click();
  await expect(mode).toHaveText("View and operate");
  await expect(
    dialog.getByRole("textbox", { name: "Pairing code" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Turn off browser access" }).click();
  await expect(pair).toBeEnabled();
});

test("desktop shows the exact port and MCP client before approving a browser takeover", async ({
  page,
}, info) => {
  await seedWorkbenchFixture(page, {
    currentPage: "settings",
    pendingTakeover: {
      takeoverId: "fixture-browser-takeover",
      clientId: "bench-assistant",
      deviceId: "device",
      target: {
        hostId: "workbench-gui-host",
        kind: "session",
        id: "session",
        sessionId: "session",
        sessionEpoch: "1",
      },
    },
  });
  await page.goto("./#/settings");
  await expect(
    page.getByText(
      "The browser asks to stop bench-assistant from writing to Virtual serial.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-takeover-approval.png"),
  });
  await page.getByRole("button", { name: "Confirm takeover" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.browserTakeoverDecisions),
    )
    .toEqual([{ takeoverId: "fixture-browser-takeover", approve: true }]);
});
