/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { TX_MAX_BYTES } from "../../packages/contracts/src/generated/types";
import { validateTxParams } from "../../packages/contracts/src/generated/validators.mjs";
import { zhCN as words } from "../../src/i18n/zh-CN";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("sends a 16.50 KB draft and the exact maximum, then explains oversized final bytes without losing the draft", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 925 });
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
  });
  await page.goto("./#/");
  await page
    .getByRole("button", {
      name: `${words["workbench.open"]} Virtual serial`,
      exact: true,
    })
    .click();
  const sender = page.getByRole("region", {
    name: words["workbench.send"],
    exact: true,
  });
  const draft = sender.getByRole("textbox", {
    name: words["workbench.draft"],
    exact: true,
  });
  const send = sender.getByRole("button", {
    name: words["workbench.send"],
    exact: true,
  });
  const content = "1234567890".repeat(1650);
  await draft.fill(content);
  await expect(
    sender.getByRole("note", { name: words["workbench.draftByteCount"] }),
  ).toHaveText("16.50 KB");
  await send.click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual([Buffer.from(content).toString("base64")]);
  await expect(draft).toHaveValue(content);

  await sender
    .getByRole("combobox", { name: words["workbench.lineEnding"] })
    .click();
  await page.getByRole("option", { name: "CRLF", exact: true }).click();
  const maximum = "A".repeat(TX_MAX_BYTES - 2);
  await draft.fill(maximum);
  await expect(send).toBeEnabled();
  await send.click();
  const bytesBase64 = Buffer.from(maximum + "\r\n").toString("base64");
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.at(-1)))
    .toBe(bytesBase64);
  expect(validateTxParams({ bytesBase64, writeWaitMs: "180000" })).toBe(true);
  expect(
    validateTxParams({
      bytesBase64: Buffer.alloc(TX_MAX_BYTES + 1).toString("base64"),
      writeWaitMs: "180000",
    }),
  ).toBe(false);

  await draft.fill(maximum + "B");
  await expect(send).toBeDisabled();
  await expect(draft).toHaveValue(maximum + "B");
  await expect(
    sender.getByRole("note", { name: words["workbench.draftByteCount"] }),
  ).toHaveText("131.07 KB");
  await expect(
    page.getByRole("alert").filter({ hasText: "单次最多发送" }),
  ).toContainText("较大内容请使用“发送文件”");
  expect(
    await page.evaluate(() => window.workbenchFixture.sentBytes.length),
  ).toBe(2);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("large-draft-limit.png") });
});
