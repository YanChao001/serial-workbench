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

test("multiline sending keeps keyboard selection and undo while mixed comments stay out of TX", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, { language: "en", sidebarCollapsed: true });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  const sender = page.getByRole("region", { name: "Send", exact: true });
  const draft = sender.getByRole("textbox", { name: "Send draft" });
  await draft.fill("x\ny\nz");
  await expect(sender.locator(".workbench-source-lines")).toHaveText("1 2 3");
  await draft.evaluate((entry: HTMLTextAreaElement) =>
    entry.setSelectionRange(0, 4, "backward"),
  );
  await draft.press("Control+BracketRight");
  await expect(draft).toHaveValue("  x\n  y\nz");
  await expect
    .poll(() =>
      draft.evaluate((entry: HTMLTextAreaElement) => [
        entry.selectionStart,
        entry.selectionEnd,
        entry.selectionDirection,
      ]),
    )
    .toEqual([2, 8, "backward"]);
  await draft.press("Control+z");
  await expect(draft).toHaveValue("x\ny\nz");

  const manyLines = Array.from(
    { length: 30 },
    (_, index) => "line " + (index + 1),
  ).join("\n");
  await draft.fill(manyLines);
  await draft.evaluate((entry: HTMLTextAreaElement) => {
    entry.scrollTop = entry.scrollHeight;
  });
  await expect
    .poll(() =>
      draft.evaluate((entry: HTMLTextAreaElement) => {
        const gutter = entry
          .closest(".workbench-source-editor")
          ?.querySelector(".workbench-source-lines");
        if (!gutter || !entry.scrollTop) return false;
        const transform = new DOMMatrix(getComputedStyle(gutter).transform);
        return transform.m42 === -entry.scrollTop;
      }),
    )
    .toBe(true);
  await draft.fill("x\ny\nz");

  await sender.getByRole("button", { name: "Mixed input" }).click();
  const dialog = page.getByRole("dialog", { name: "Mixed input" });
  const mixed = dialog.getByRole("textbox", { name: "Mixed input" });
  const original = '41\n42\n"AB"';
  const selectMiddle = () =>
    mixed.evaluate((entry: HTMLTextAreaElement) =>
      entry.setSelectionRange(3, 5),
    );
  await mixed.fill(original);
  await expect(dialog.getByText("41 42 41 42", { exact: true })).toBeVisible();
  await expect(dialog.locator(".workbench-source-lines")).toHaveText("1 2 3");
  await selectMiddle();
  await mixed.press("Control+Slash");
  await expect(mixed).toHaveValue('41\n/*42*/\n"AB"');
  await expect(dialog.locator('[data-source-token="comment"]')).toHaveText(
    "/*42*/",
  );
  await expect(dialog.locator('[data-source-token="string"]')).toHaveText(
    '"AB"',
  );
  await expect(dialog.getByText("41 41 42", { exact: true })).toBeVisible();
  await mixed.press("Control+z");
  await expect(mixed).toHaveValue(original);
  await expect(dialog.getByText("41 42 41 42", { exact: true })).toBeVisible();

  await selectMiddle();
  await dialog.getByRole("button", { name: "Toggle block comment" }).click();
  await expect(mixed).toBeFocused();
  await expect(mixed).toHaveValue('41\n/*42*/\n"AB"');
  await mixed.press("Tab");
  await expect(mixed).not.toBeFocused();
  await dialog.getByRole("button", { name: "Use as HEX draft" }).click();
  await expect(draft).toHaveValue("41 41 42");
  await expect(sender.locator('[data-source-token="hex"]')).toHaveText(
    "41 41 42",
  );
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await sender.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([Buffer.from([0x41, 0x41, 0x42]).toString("base64")]);
});
