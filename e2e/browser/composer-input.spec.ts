/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";

for (const language of ["en", "zh"] as const)
  test(`clearing a send draft preserves the other view and immediately saves and sends its latest text (${language})`, async ({
    page,
  }, info) => {
    const words = language === "zh" ? zhCN : en;
    await seedWorkbenchFixture(page, {
      language,
      sidebarCollapsed: true,
      theme: language === "zh" ? "dark" : "light",
    });
    await page.goto("./#/");
    await page
      .getByRole("button", {
        name: `${words["workbench.open"]} Virtual serial`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: words["workbench.closeSession"],
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("tab", { name: "Virtual serial", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const draft = page.getByRole("textbox", {
      name: words["workbench.draft"],
      exact: true,
    });
    await draft.fill("FIRST DRAFT");
    await page
      .getByRole("button", {
        name: words["workbench.duplicateView"],
        exact: true,
      })
      .click();
    const tabs = page
      .getByRole("tablist", { name: words["workbench.sessions"] })
      .getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await draft.fill("SECOND DRAFT");
    await tabs.nth(0).click();
    await expect(draft).toHaveValue("FIRST DRAFT");
    const clear = page.getByRole("button", {
      name: words["workbench.clearDraft"],
      exact: true,
    });
    await clear.click();
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("");
    await expect(clear).toBeDisabled();
    await expect(
      page.getByRole("note", { name: words["workbench.draftByteCount"] }),
    ).toHaveText("0 B");
    await page.screenshot({ path: info.outputPath("send-draft-erased.png") });
    await tabs.nth(1).click();
    await expect(draft).toHaveValue("SECOND DRAFT");
    await draft.press("End");
    await draft.press("0");
    await page
      .getByRole("button", { name: words["workbench.saveDrafts"], exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(
            window.workbenchFixture.clientStateWrites.at(-1)?.drafts ?? {},
          ),
        ),
      )
      .toEqual(expect.arrayContaining(["", "SECOND DRAFT0"]));
    await page
      .getByRole("button", { name: words["workbench.send"], exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes.at(-1)))
      .toBe(Buffer.from("SECOND DRAFT0").toString("base64"));
  });
