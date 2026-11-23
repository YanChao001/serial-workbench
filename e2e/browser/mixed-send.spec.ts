/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("mixed input uses the selected send encoding and submits the HEX draft with its ending", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    sharedSettings: {
      terminal: {
        receiveMode: "text",
        sendMode: "text",
        lineEnding: { kind: "crlf" },
        sendEncoding: "utf-16le",
      },
    },
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toBeEnabled();

  const sender = page.getByRole("region", { name: "Send", exact: true });
  const draft = sender.getByRole("textbox", { name: "Send draft" });
  await draft.fill("old draft");
  const entry = sender.getByRole("button", { name: "Mixed input" });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "Mixed input" });
  const mixed = dialog.getByRole("textbox", { name: "Mixed input" });
  const apply = dialog.getByRole("button", { name: "Use as HEX draft" });
  await mixed.fill("41 F");
  await expect(apply).toBeDisabled();
  await mixed.press("Escape");
  await expect(entry).toBeFocused();
  await expect(draft).toHaveValue("old draft");

  await entry.click();
  await mixed.fill(String.raw`41 "中" \x00`);
  await expect(dialog.getByText("41 2D 4E 00", { exact: true })).toBeVisible();
  await apply.click();
  await expect(draft).toHaveValue("41 2D 4E 00");
  await expect(sender.getByRole("radio", { name: "HEX" })).toBeChecked();
  await expect(sender.getByRole("note", { name: "Bytes to send" })).toHaveText(
    "8 B",
  );
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );

  await sender.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([
      Buffer.from([0x41, 0x2d, 0x4e, 0, 13, 0, 10, 0]).toString("base64"),
    ]);
});
