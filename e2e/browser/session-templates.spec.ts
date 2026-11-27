import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { session } from "../../src/features/workbench/test-fixtures";

async function openTemplates(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .press("ArrowDown");
  await page
    .getByRole("menuitem", { name: "Session templates", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Session templates", exact: true });
}

async function selectTemplate(page: Page, name: string) {
  await page
    .getByRole("combobox", { name: "Session template", exact: true })
    .click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("session templates preview locally and require an explicit serial open", async ({
  page,
}) => {
  await seedWorkbenchFixture(page, {});
  await page.goto("./#/");
  const dialog = await openTemplates(page);
  await expect(dialog.getByText("115200 / 8N1")).toBeVisible();
  await expect(dialog.getByText("Boot OK", { exact: true })).toBeVisible();

  await selectTemplate(page, "Modbus slave");
  const open = dialog.getByRole("button", { name: "Open with template" });
  await expect(open).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "Manage plugins" }),
  ).toHaveAttribute("href", "#/plugins");

  await selectTemplate(page, "AT module");
  await expect(
    dialog.getByRole("textbox", { name: "Pending AT command (optional)" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.workbenchFixture.connectRequests),
  ).toEqual([]);
  await open.click();
  await expect
    .poll(() => page.evaluate(() => window.workbenchFixture.connectRequests))
    .toEqual([
      {
        deviceId: "device",
        params: {
          configuration: expect.objectContaining({
            baudRate: "115200",
            dataBits: "8",
            parity: "none",
            stopBits: "one",
            flowControl: "none",
          }),
        },
      },
    ]);
  await dialog.getByRole("button", { name: "Use AT example" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Pending AT command (optional)" }),
  ).toHaveValue("AT+CREG?");
  expect(await page.evaluate(() => window.workbenchFixture.sentBytes)).toEqual(
    [],
  );
});

test("the three runnable examples preview and save fixed artifacts without opening or writing to a device", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 780 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  const dialog = await openTemplates(page);
  await selectTemplate(page, "Arduino sample");
  const example = dialog.getByRole("region", { name: "Run the example" });
  await expect(example.getByText("READ", { exact: true })).toBeVisible();
  await expect(example.getByText("3.250", { exact: true })).toBeVisible();
  await expect(
    example.getByText("node swb-example-peer.mjs arduino"),
  ).toBeVisible();
  const savePeer = example.getByRole("button", { name: "Save simulator" });
  const saveSketch = example.getByRole("button", {
    name: "Save Arduino sketch",
  });
  await page.evaluate(() => {
    window.workbenchFixture.cancelSampleProjectExport = true;
  });
  await savePeer.press("Space");
  await expect(savePeer).toBeFocused();
  await expect(example.getByRole("status")).toHaveCount(0);
  await page.evaluate(() => {
    window.workbenchFixture.cancelSampleProjectExport = false;
  });
  await saveSketch.click();
  await expect(example.getByRole("status")).toHaveText("Example file saved.");
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.sampleProjectExports),
    )
    .toEqual(["peer", "arduinoSketch"]);
  await example.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sample-project-wide.png") });

  await selectTemplate(page, "AT module");
  await expect(example.getByText("AT+CREG?", { exact: true })).toBeVisible();
  await expect(example.getByText(/\+CREG: 0,1\s+OK/)).toBeVisible();
  await expect(example.getByText("node swb-example-peer.mjs at")).toBeVisible();
  await expect(saveSketch).toHaveCount(0);
  await expect(
    dialog.getByRole("textbox", { name: "Pending AT command (optional)" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 420, height: 600 });
  await selectTemplate(page, "Modbus RTU register read");
  await expect(
    example.getByText("01 03 00 00 00 02 C4 0B", { exact: true }),
  ).toBeVisible();
  await expect(
    example.getByText("01 03 04 12 34 00 2A 3F 5A", { exact: true }),
  ).toBeVisible();
  await expect(
    example.getByText("node swb-example-peer.mjs modbus"),
  ).toBeVisible();
  expect(
    await example.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await example.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sample-project-narrow.png") });

  const workbenchActions = () =>
    page.evaluate(() => ({
      connections: window.workbenchFixture.connectRequests,
      sends: window.workbenchFixture.sentBytes,
    }));
  expect(await workbenchActions()).toEqual({ connections: [], sends: [] });
  await dialog.getByRole("button", { name: "Open with template" }).click();
  await expect.poll(workbenchActions).toMatchObject({
    connections: [
      { params: { configuration: { baudRate: "19200", parity: "even" } } },
    ],
    sends: [],
  });
});

test("an available Modbus slave action permits opening with the template without starting the slave", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-modbus-slave/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid Modbus slave manifest");
  const [action] = manifest.contributes.actions;
  if (!action) throw new Error("Missing Modbus slave action");

  await seedWorkbenchFixture(page, {
    openedConfiguration: {
      ...session().configuration,
      baudRate: "19200",
      parity: "even",
    },
    framing: {
      action,
      initiallyUnavailable: true,
      page: {
        fileRef: {
          hostId: "workbench-gui-host",
          kind: "plugin_result",
          id: "not-read",
          revision: "1",
        },
        offset: "0",
        nextOffset: "0",
        totalBytes: "0",
        bytesBase64: "",
        fingerprint: createHash("sha256").update("").digest("hex"),
        atEnd: true,
      },
    },
  });
  await page.goto("./#/");
  const dialog = await openTemplates(page);
  await selectTemplate(page, "Modbus slave");
  const open = dialog.getByRole("button", { name: "Open with template" });
  await expect(open).toBeDisabled();
  await dialog.getByRole("link", { name: "Manage plugins" }).click();
  await expect(page).toHaveURL(/#\/plugins$/);
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.evaluate(() => window.workbenchFixture.registerFramingAction());
  await page.goBack();
  await expect(page).toHaveURL(/#\/$/);
  await openTemplates(page);
  await selectTemplate(page, "Modbus slave");
  await expect(dialog.getByText("19200 / 8E1")).toBeVisible();
  await expect(open).toBeEnabled();
  const start = dialog.getByRole("button", { name: "Start slave" });
  await expect(start).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open with template" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.connectRequests[0]?.params),
    )
    .toMatchObject({
      configuration: {
        baudRate: "19200",
        dataBits: "8",
        parity: "even",
        stopBits: "one",
        flowControl: "none",
      },
    });
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  await selectTemplate(page, "AT module");
  await expect(
    dialog.getByText(
      "Close the open session before applying these line settings.",
    ),
  ).toBeVisible();
  await expect(open).toBeDisabled();
  const preview = dialog
    .getByText("Template line settings", { exact: true })
    .locator("..");
  const current = dialog
    .getByText("Current connection", { exact: true })
    .locator("..");
  await expect(
    preview.getByText("115200 / 8N1", { exact: true }),
  ).toBeVisible();
  await expect(current.getByText("19200 / 8E1", { exact: true })).toBeVisible();
  const widePreview = await preview.boundingBox();
  const wideCurrent = await current.boundingBox();
  if (!widePreview || !wideCurrent)
    throw new Error("Missing line settings bounds");
  expect(wideCurrent.y).toBe(widePreview.y);
  expect(wideCurrent.x).toBeGreaterThan(widePreview.x + widePreview.width);

  await page.setViewportSize({ width: 436, height: 650 });
  const narrowPreview = await preview.boundingBox();
  const narrowCurrent = await current.boundingBox();
  if (!narrowPreview || !narrowCurrent)
    throw new Error("Missing narrow line settings bounds");
  expect(narrowCurrent.x).toBe(narrowPreview.x);
  expect(narrowCurrent.y).toBeGreaterThanOrEqual(
    narrowPreview.y + narrowPreview.height,
  );
  await preview
    .locator("..")
    .screenshot({ path: info.outputPath("session-lines-narrow.png") });

  await selectTemplate(page, "Modbus slave");
  await dialog.getByRole("button", { name: "Use server example" }).click();
  await expect(start).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Open with template" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      (id) =>
        window.workbenchFixture.invocations.filter(
          (call) => call.actionId === id,
        ),
      action.actionId,
    ),
  ).toEqual([]);
});
