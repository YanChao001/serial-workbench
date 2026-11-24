import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { NodePackageSourceKey } from "@serial-workbench/contracts";
import bundledFraming from "../../crates/host/resources/node-packages/framing.json" with { type: "json" };
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import { seedWorkbenchFixture } from "./workbench.fixture";

const manifestDocument: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/plugin-sdk/examples/reference-terminal/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (!validateNodePackageManifest(manifestDocument))
  throw new Error("Invalid terminal manifest");
const terminalManifest = manifestDocument;

const archiveSha256 = "a".repeat(64);
const publicKeySha256 = "b".repeat(64);
const source = {
  source: "Workbench",
  keyId: "terminal-signing",
  publicKey: [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  ],
  publicKeySha256,
  approved: true,
} satisfies NodePackageSourceKey;

function terminalPlugin() {
  return {
    archive: {
      reference: {
        kind: "file",
        id: "reference-terminal",
        hostId: "workbench-gui-host",
      },
      name: "terminal.zip",
      length: "4096",
      mime: "application/zip",
    },
    installation: {
      manifest: terminalManifest,
      archiveSha256,
      verifiedSource: {
        source: source.source,
        keyId: source.keyId,
        publicKeySha256,
      },
      enabled: false,
      executionTrust: null,
    },
    source,
  };
}

test("an active bundled plugin shows its product source without a user key", async ({
  page,
}) => {
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
    throw new Error("Invalid bundled framing manifest");
  const { source, keyId, publicKeySha256 } = bundledFraming.sourceApproval;
  const verifiedSource = { source, keyId, publicKeySha256 };
  await seedWorkbenchFixture(page, {
    plugin: {
      archive: terminalPlugin().archive,
      initiallyInstalled: true,
      installation: {
        manifest,
        archiveSha256: bundledFraming.archiveSha256,
        verifiedSource,
        enabled: true,
        executionTrust: {
          archiveSha256: bundledFraming.archiveSha256,
          permissions: manifest.permissions,
          verifiedSource,
        },
      },
    },
  });
  await page.goto("./#/plugins");
  const row = page.getByRole("button", {
    name: /Serial Workbench Framing.*Enabled/,
  });
  await row.click();
  await expect(page.getByText("Included with Serial Workbench")).toBeVisible();
  await expect(page.getByText(/Trust removed for/)).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Disable", exact: true }),
  ).toBeVisible();
});

test("install, trust and enable a plugin without exposing internal identifiers", async ({
  page,
}, testInfo) => {
  await seedWorkbenchFixture(page, { plugin: terminalPlugin(), theme: "dark" });
  await page.goto("./#/plugins");
  await expect(page.getByText("No plugins installed yet")).toBeVisible();
  await expect(page.getByLabel("Signing key name")).toBeHidden();

  await page
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  const installer = page.getByRole("dialog", { name: "Install plugin" });
  await installer.getByRole("combobox", { name: "Plugin source" }).click();
  await page.getByRole("option", { name: "Workbench", exact: true }).click();
  await expect(installer.getByRole("combobox")).toHaveText("Workbench");
  await page.screenshot({ path: testInfo.outputPath("install-dark.png") });
  await installer.getByRole("button", { name: "Choose plugin file" }).click();

  await expect(page.getByText("Installed Serial Monitor.")).toHaveCount(1);
  const row = page.getByRole("button", {
    name: /Serial Monitor.*Needs your approval/,
  });
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toContainText(`Version ${terminalManifest.version}`);
  await expect(page.getByText("Signature verified · Workbench")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("installed-dark.png") });

  await page
    .getByRole("button", { name: "Trust this plugin", exact: true })
    .click();
  const trust = page.getByRole("dialog", { name: "Trust this plugin" });
  await expect(trust.getByText("Read serial data")).toBeVisible();
  await expect(
    trust.getByText(/access files and the network and start programs/),
  ).toBeVisible();
  for (const technicalText of [
    archiveSha256,
    publicKeySha256,
    "fixture-plugin-operation-",
    terminalManifest.id,
    "content.read",
  ]) {
    await expect(page.locator("body")).not.toContainText(technicalText);
  }
  await page.screenshot({ path: testInfo.outputPath("trust-dark.png") });
  await trust.getByRole("button", { name: "Trust this plugin" }).click();
  await expect(
    page.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Serial Monitor.*Disabled/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Serial Monitor.*Enabled/ }),
  ).toBeVisible();

  await page.locator('a[href="#/"]').click();
  await expect(page).toHaveURL(/#\/$/);
  await page.evaluate(() => {
    window.workbenchFixture.limitPluginReads = true;
  });
  await page.locator('a[href="#/plugins"]').click();
  await expect(page).toHaveURL(/#\/plugins$/);
  await expect(
    page.getByRole("button", { name: "Install plugin", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove plugin trust" }).click();
  const revoke = page.getByRole("dialog", { name: "Remove plugin trust" });
  await revoke.getByRole("button", { name: "Remove plugin trust" }).click();
  await expect(row).toBeVisible();

  const intents = await page.evaluate(
    () => window.workbenchFixture.pluginIntents,
  );
  expect(intents).toMatchObject([
    {
      kind: "install",
      expectedRevision: "0",
      params: {
        source: { kind: "trusted", source: source.source, keyId: source.keyId },
      },
    },
    {
      kind: "confirmExecutionTrust",
      expectedRevision: "1",
      params: { id: terminalManifest.id, archiveSha256 },
    },
    {
      kind: "setEnabled",
      expectedRevision: "2",
      params: { id: terminalManifest.id, archiveSha256, enabled: true },
    },
    {
      kind: "revokeExecutionTrust",
      expectedRevision: "3",
      params: { id: terminalManifest.id, archiveSha256 },
    },
  ]);

  const manageSources = page.getByRole("button", { name: "Manage sources" });
  await expect(manageSources).toHaveAttribute("aria-expanded", "false");
  await manageSources.click();
  await expect(
    page.getByRole("button", { name: "Remove source trust" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(publicKeySha256);
});

test("a narrow Chinese installation shows an actionable error without native diagnostics", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 780 });
  await seedWorkbenchFixture(page, {
    plugin: terminalPlugin(),
    language: "zh",
    sidebarCollapsed: true,
  });
  await page.goto("./#/plugins");
  await page.getByRole("button", { name: "安装插件", exact: true }).click();
  const installer = page.getByRole("dialog", { name: "安装插件" });
  await expect(
    installer.getByRole("button", { name: "选择插件文件" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("install-zh-narrow.png") });
  await page.evaluate(() => {
    window.workbenchFixture.pluginInstallFailure = true;
  });
  await installer.getByRole("button", { name: "选择插件文件" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "无法安装插件。请检查文件和所选来源，然后重试。" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(archiveSha256);
  await expect(
    page.getByRole("button", { name: "安装插件", exact: true }),
  ).toBeEnabled();
});
