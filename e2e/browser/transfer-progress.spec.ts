import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";

async function openFileTransfer(page: Page) {
  await seedWorkbenchFixture(page, {
    transferSource: {
      reference: {
        hostId: "workbench-gui-host",
        kind: "file",
        id: "fixed-source",
        revision: "1",
      },
      name: "payload.bin",
      length: "10",
      mime: "application/octet-stream",
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Virtual serial", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "File transfer", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "File transfer",
    exact: true,
  });
}

test("file transfer follows Host byte evidence and explicitly cancels the same operation", async ({
  page,
}) => {
  const dialog = await openFileTransfer(page);
  await dialog.getByRole("button", { name: "Select source file" }).click();
  await expect(dialog.getByText("payload.bin", { exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "Advanced", exact: true }).click();
  await dialog.getByLabel("Chunk size (bytes)").fill("2");
  await dialog.getByRole("button", { name: "Send file", exact: true }).click();
  const bar = dialog.getByRole("progressbar", { name: "Transfer progress" });
  await expect(bar).toHaveAttribute("aria-valuetext", "0 B / 10 B");

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.setTransferProgress("4", "1", "running", "6"),
      ),
    )
    .toBeGreaterThan(0);
  await expect(bar).toHaveAttribute("aria-valuetext", "4 B / 10 B");
  await expect(dialog.getByLabel("Source bytes read")).toHaveText("6 B");
  await expect(dialog.getByLabel("Bytes with unknown outcome")).toHaveText(
    "1 B",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations
          .filter(({ actionId }) => actionId === "operation.cancel")
          .map(({ target }) => target.id),
      ),
    )
    .toEqual(["fixture-file-transfer"]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.setTransferProgress("4", "0", "cancelled", "8"),
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    dialog.getByRole("status").filter({ hasText: "Stopped" }),
  ).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuetext", "4 B / 10 B");
  await expect(dialog.getByLabel("Source bytes read")).toHaveText("8 B");
  await expect(dialog.getByLabel("Bytes with unknown outcome")).toHaveText(
    "0 B",
  );
  await expect(
    dialog.getByText("No device acknowledgement provided"),
  ).toBeVisible();
});

test("a native drop previews one file at the source field and never submits until confirmed", async ({
  page,
}) => {
  const dialog = await openFileTransfer(page);
  const source = dialog.getByLabel("Source file", { exact: true });
  await expect(source).toHaveText("Drop one file here");
  const [x, y] = await source.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    return [
      (rect.left + rect.width / 2) * ratio,
      (rect.top + rect.height / 2) * ratio,
    ];
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.dropTransferFile(-10, -10)),
    )
    .toBe(1);
  await page.evaluate(
    ({ x, y }) => window.workbenchFixture.dropTransferFile(x, y, "99999"),
    { x, y },
  );
  expect(
    await page.evaluate(() => window.workbenchFixture.transferDropClaims),
  ).toEqual([]);
  await page.evaluate(
    ({ x, y }) => window.workbenchFixture.dropTransferFile(x, y),
    { x, y },
  );
  await expect(source).toHaveText("payload.bin");
  expect(
    await page.evaluate(() => window.workbenchFixture.transferDropClaims),
  ).toEqual(["91"]);
  expect(
    await page.evaluate(() =>
      window.workbenchFixture.invocations.filter(
        ({ actionId }) => actionId === "transfer.file",
      ),
    ),
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Send file", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.workbenchFixture.invocations
          .filter(({ actionId }) => actionId === "transfer.file")
          .map(({ params }) => params),
      ),
    )
    .toMatchObject([
      { sourceRef: { id: "fixed-source" }, offset: "0", length: "10" },
    ]);
});
