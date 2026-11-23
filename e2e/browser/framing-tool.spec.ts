import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import { en } from "../../src/i18n/en";
import { seedWorkbenchFixture } from "./workbench.fixture";
import { workbenchStreamItems } from "./workbench-stream.fixture";

test("the framing tool follows the selected session and points to the catalog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await seedWorkbenchFixture(page, { language: "en" });
  await page.goto("./#/");
  const menu = page.getByRole("button", { name: en["workbench.tools.more"] });
  const name = en["workbench.tools.framing"];
  const dialog = page.getByRole("dialog", { name });
  const openFraming = async () => {
    await menu.click();
    await page.getByRole("menuitem", { name }).click();
    await expect(dialog).toBeVisible();
  };
  await openFraming();
  await expect(
    dialog.getByText(en["workbench.framing.selectSession"]),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();

  await page
    .getByRole("button", {
      name: `${en["workbench.open"]} Virtual serial`,
      exact: true,
    })
    .click();
  await openFraming();
  await expect(
    dialog.getByText(en["workbench.framing.unavailable"]),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: en["workbench.framing.openPlugins"] }),
  ).toHaveAttribute("href", "#/plugins");
});

test("the workbench scans only visible receive data through the Host action and result file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-framing/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid framing catalog fixture");
  const action = manifest.contributes.parsers[0];
  if (!action) throw new Error("Missing framing catalog fixture");
  const reference = {
    hostId: "workbench-gui-host",
    kind: "plugin_result",
    id: "framed-fixture",
    revision: "1",
  };
  const encoded = Buffer.from(
    JSON.stringify({
      frames: [
        {
          bytesBase64: "QQo=",
          source: {
            hostId: reference.hostId,
            sessionId: "session",
            sessionEpoch: "1",
            direction: "rx",
            eventStart: "4",
            eventEnd: "5",
            byteStart: "7",
            byteEnd: "9",
          },
        },
      ],
      incompleteBytes: 0,
    }),
  );
  await seedWorkbenchFixture(page, {
    language: "en",
    framing: {
      action,
      page: {
        fileRef: reference,
        offset: "0",
        nextOffset: String(encoded.length),
        totalBytes: String(encoded.length),
        bytesBase64: encoded.toString("base64"),
        fingerprint: createHash("sha256").update(encoded).digest("hex"),
        atEnd: true,
      },
    },
  });
  await page.goto("./#/");
  await page
    .getByRole("button", { name: "Open Virtual serial", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workbenchFixture.rawSubscriptions.length),
    )
    .toBe(1);
  const sample = workbenchStreamItems().find(
    (item) => item.kind === "source" && item.event.kind === "rx",
  );
  if (sample?.kind !== "source") throw new Error("Missing Raw RX fixture");
  const visible = (eventSeq: string, byteStart: string, content: string) => ({
    kind: "source",
    event: {
      ...sample.event,
      kind: "rx",
      eventSeq,
      payload: {
        bytesBase64: Buffer.from(content).toString("base64"),
        byteStart,
        byteEnd: String(Number(byteStart) + content.length),
      },
    },
  });
  await page.evaluate(
    (item) => window.workbenchFixture.emitRaw([item]),
    visible("3", "0", "CLEARED"),
  );
  const log = page.getByRole("log");
  await expect(log).toContainText("CLEARED");
  await page
    .getByRole("button", { name: en["workbench.tools.clearView"], exact: true })
    .click();
  await expect(log).not.toContainText("CLEARED");
  await page.evaluate(
    (item) => window.workbenchFixture.emitRaw([item]),
    visible("4", "7", "A\n"),
  );
  await expect(log.getByText("A", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: en["workbench.tools.more"] }).click();
  await page
    .getByRole("menuitem", { name: en["workbench.tools.framing"] })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en["workbench.tools.framing"],
  });
  await expect(dialog.getByLabel(en["workbench.framing.start"])).toHaveValue(
    "4",
  );
  await expect(dialog.getByLabel(en["workbench.framing.end"])).toHaveValue("5");
  await dialog
    .getByRole("combobox", { name: en["workbench.framing.mode"] })
    .click();
  await page
    .getByRole("option", {
      name: en["workbench.framing.delimiter"],
      exact: true,
    })
    .click();
  await dialog.getByLabel(en["workbench.framing.delimiterHex"]).fill("0A");
  await dialog
    .getByRole("button", { name: en["workbench.framing.scan"] })
    .click();

  await expect(dialog.getByText("41 0A", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Bytes 7 to 9/)).toBeVisible();
  const checked = await page.evaluate((id) => {
    const fixture = window.workbenchFixture;
    return {
      call: fixture.invocations.find((item) => item.actionId === id),
      query: fixture.queryInputs.find(
        (item) =>
          item.actionId === "action.check" && item.params.actionId === id,
      ),
      observed: fixture.hostQueries.includes("operation.get"),
      read: fixture.hostQueries.includes("file.read"),
    };
  }, action.actionId);
  expect(checked.call?.params).toEqual({
    startEventSeq: "4",
    endEventSeq: "5",
    maxFrameLength: 4096,
    delimiterBase64: "Cg==",
  });
  expect(checked.query?.target).toEqual(checked.call?.target);
  expect(checked.observed).toBe(true);
  expect(checked.read).toBe(true);
});
