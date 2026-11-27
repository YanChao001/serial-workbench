import { expect, test, type Page } from "@playwright/test";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

async function receive(page: Page, readOnly = false, splitRecord = false) {
  await seedWorkbenchFixture(page, {
    language: "en",
    sidebarCollapsed: true,
    manualSendReceipts: true,
    readOnly,
  });
  await page.goto("./#/");
  await page.getByRole("button", { name: "Open Virtual serial" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const input = workbenchStreamItems().filter(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (splitRecord) {
    const [item] = input;
    if (item?.kind !== "source" || item.event.kind !== "rx")
      throw new Error("Expected the source RX fixture");
    const event = item.event;
    input.splice(
      0,
      1,
      {
        kind: "source",
        event: {
          ...event,
          payload: { ...event.payload, bytesBase64: "T0s=", byteEnd: "2" },
        },
      },
      {
        kind: "source",
        event: {
          ...event,
          eventSeq: "4",
          time: {
            ...event.time,
            sourceMonoNs: "1001000",
            receivedWallTime: "2026-11-10T11:22:33.457Z",
          },
          payload: { ...event.payload, bytesBase64: "DQo=", byteStart: "2" },
        },
      },
    );
  }
  await page.evaluate(
    (items: unknown[]) => window.workbenchFixture.emitRaw(items),
    input as unknown[],
  );
  const terminal = page.getByRole("region", { name: "Receive", exact: true });
  await terminal.getByRole("radio", { name: "HEX", exact: true }).click();
  const log = terminal.getByRole("log");
  const hex = log.locator("[data-direction=rx] [data-hex-source]");
  await expect(hex).toHaveText("4F 4B 0D 0A");
  async function selectFirstTwo() {
    await hex.evaluate((element) => {
      const node = element.firstChild;
      if (!node) throw new Error("Missing HEX selection");
      document.getSelection()?.setBaseAndExtent(node, 0, node, 5);
    });
  }
  return {
    terminal,
    log,
    hex,
    selectFirstTwo,
    menu: page.getByRole("menu", { name: "Receive actions" }),
  };
}

test("receive context copies, previews exact selected bytes, and locates the original bookmarked record", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  const { terminal, log, hex, selectFirstTwo, menu } = await receive(page);
  const draft = page.getByRole("textbox", { name: "Send draft" });
  await draft.fill("keep this draft");

  await selectFirstTwo();
  await hex.click({ button: "right", position: { x: 4, y: 7 } });
  await expect(menu).toBeVisible();
  const copyAs = menu.getByRole("menuitem", { name: "Copy as" });
  await copyAs.press("ArrowRight");
  await page.getByRole("menuitem", { name: "HEX", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.copiedLanInfo.at(-1)),
    )
    .toBe("4F 4B");
  await expect(
    terminal.getByText("Copied to clipboard", { exact: true }),
  ).toBeVisible();

  await selectFirstTwo();
  await log.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Preview send selection" }).click();
  const preview = page.getByRole("dialog", { name: "Preview send selection" });
  const confirm = preview.getByRole("button", { name: "Confirm send" });
  await expect(preview).toContainText("Virtual serial · 2 B · Event 3");
  await expect(preview.locator("pre")).toHaveText("4F 4B");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await page.setViewportSize({ width: 420, height: 480 });
  await expect(confirm).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("receive-context-send-narrow.png"),
  });
  await confirm.click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.sentBytes))
    .toEqual(["T0s="]);
  await expect(preview.getByRole("status")).toContainText("manual-tx-1");
  const write = await page.evaluate(() =>
    window.workbenchFixture.invocations
      .filter(({ actionId }) => actionId === "session.tx")
      .map(({ target, expectedRevision }) => ({
        hostId: target.hostId,
        sessionId: target.sessionId,
        sessionEpoch: target.sessionEpoch,
        expectedRevision,
      })),
  );
  const revision = await page.evaluate(
    () => window.workbenchFixture.manualSendRevision,
  );
  expect(write).toEqual([
    {
      hostId: "workbench-gui-host",
      sessionId: "session",
      sessionEpoch: "1",
      expectedRevision: revision,
    },
  ]);
  await expect(confirm).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(log).toBeFocused();
  await expect(draft).toHaveValue("keep this draft");

  await hex.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Add time bookmark" }).click();
  await hex.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Split at this record" }).click();
  await expect(log.locator('[data-location-target="true"]')).toContainText(
    "OK",
  );
  await expect(
    log.locator('[data-location-target="true"] [data-hex-source]'),
  ).toHaveText("4F 4B 0D 0A");

  const location = terminal.getByRole("button", { name: "Record location" });
  await location.click();
  const locations = page.getByRole("dialog", { name: "Record location" });
  const bookmark = locations.getByRole("button", { name: /Event 3/ });
  await expect(bookmark).toContainText("2026-11-10T11:22:33.456Z");
  await bookmark.click();
  await expect(locations.getByRole("status")).toContainText("Event 3");
  await page.keyboard.press("Escape");
  await terminal.getByRole("button", { name: "Clear receive view" }).click();
  await location.click();
  await bookmark.click();
  await expect(locations.getByRole("status")).toContainText(
    "This record is unavailable in the current history.",
  );
  await locations.getByRole("button", { name: "Remove bookmark" }).click();
  await expect(bookmark).toHaveCount(0);
});

test("one displayed RX record keeps the original event of a byte selection inside its second chunk", async ({
  page,
}) => {
  const { terminal, log, hex, menu } = await receive(page, false, true);
  async function selectSecondChunk() {
    await hex.evaluate((element) => {
      const node = element.firstChild;
      if (!node) throw new Error("Missing merged HEX row");
      document.getSelection()?.setBaseAndExtent(node, 6, node, 11);
    });
    await log.press("Shift+F10");
  }
  await selectSecondChunk();
  await menu.getByRole("menuitem", { name: "Preview send selection" }).click();
  const preview = page.getByRole("dialog", { name: "Preview send selection" });
  await expect(preview.locator("pre")).toHaveText("0D 0A");
  await expect(preview).toContainText("Event 4");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();

  await selectSecondChunk();
  await menu.getByRole("menuitem", { name: "Add time bookmark" }).click();
  await selectSecondChunk();
  await menu.getByRole("menuitem", { name: "Split at this record" }).click();
  await expect(
    log.locator('[data-location-target="true"] [data-hex-source]'),
  ).toHaveText("4F 4B 0D 0A");

  await terminal.getByRole("button", { name: "Record location" }).click();
  const locations = page.getByRole("dialog", { name: "Record location" });
  const bookmark = locations.getByRole("button", { name: /Event 4/ });
  await expect(bookmark).toContainText("2026-11-10T11:22:33.457Z");
  await bookmark.click();
  await expect(locations.getByRole("status")).toContainText("Event 4");
});

test("a read-only record retains navigation without offering a write", async ({
  page,
}) => {
  const { hex, selectFirstTwo, menu } = await receive(page, true);
  await selectFirstTwo();
  await hex.click({ button: "right", position: { x: 4, y: 7 } });
  await expect(
    menu.getByRole("menuitem", { name: "Preview send selection" }),
  ).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Copy as" })).toBeEnabled();
  await expect(
    menu.getByRole("menuitem", { name: "Add time bookmark" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("revoking access after selecting bytes disables confirmation", async ({
  page,
}) => {
  const { hex, selectFirstTwo, menu } = await receive(page);
  await selectFirstTwo();
  await hex.click({ button: "right", position: { x: 4, y: 7 } });
  await menu.getByRole("menuitem", { name: "Preview send selection" }).click();
  const preview = page.getByRole("dialog", { name: "Preview send selection" });
  const confirm = preview.getByRole("button", { name: "Confirm send" });
  await expect(confirm).toBeEnabled();
  const ended = await page.evaluate(() => {
    const native = (
      window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (!native) throw new Error("Missing desktop fixture");
    const invoke = native.invoke.bind(native);
    const error = {
      code: "PERMISSION_DENIED",
      message: "Fixture read access revoked",
      retryable: false,
    };
    native.invoke = async (command, args) => {
      if (command === "host_raw_subscribe") throw error;
      return invoke(command, args);
    };
    return window.workbenchFixture.endRaw(error);
  });
  expect(ended).toBe(1);
  await expect(preview.getByRole("alert")).toContainText("permissions changed");
  await expect(preview.locator("pre")).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});
