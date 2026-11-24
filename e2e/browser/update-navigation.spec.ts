import { expect, test } from "@playwright/test";
import { showUpgradeWorkbench } from "../update-workbench-navigation";
import { seedWorkbenchFixture } from "./workbench.fixture";

test("the upgrade harness shows the cached Workbench from Updates", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  const shell = page.getByTestId("serial-workbench-shell");
  await expect(shell).toBeVisible();
  await showUpgradeWorkbench(page);

  await page.evaluate(() => {
    location.hash = "/updates";
  });
  await expect(page).toHaveURL(/#\/settings\?section=updates$/);
  await expect(page.locator("#settings-updates")).toBeVisible();
  await expect(shell).toBeAttached();
  await expect(shell).toBeHidden();

  await showUpgradeWorkbench(page);
  await expect(page).toHaveURL(/#\/$/);
  await expect(shell).toBeVisible();
});
