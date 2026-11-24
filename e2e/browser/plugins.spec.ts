import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import type { NodePackageInstallation, NodePackageSourceKey } from "@serial-workbench/contracts";
import bundledFraming from "../../crates/host/resources/node-packages/framing.json" with { type: "json" };
import { validateNodePackageManifest } from "../../packages/contracts/src/generated/validators.mjs";
import { alignXY } from "../../packages/plugin-sdk/examples/reference-statistics/align-xy";
import { summarize } from "../../packages/plugin-sdk/examples/reference-statistics/main";
import { spectrum } from "../../packages/plugin-sdk/examples/reference-statistics/spectrum";
import { getLocale } from "../../src/i18n/registry";
import { createTranslator } from "../../src/i18n/translate";
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

function statisticsPlugin() {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-statistics/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(manifest))
    throw new Error("Invalid statistics manifest");
  const archiveSha256 = "e".repeat(64);
  const verifiedSource = {
    source: "Workbench",
    keyId: "statistics-signing",
    publicKeySha256: "f".repeat(64),
  };
  const installation = {
    manifest,
    archiveSha256,
    verifiedSource,
    enabled: true,
    executionTrust: {
      archiveSha256,
      permissions: manifest.permissions,
      verifiedSource,
    },
  } satisfies NodePackageInstallation;
  const archive = {
    reference: {
      kind: "file",
      id: "reference-statistics",
      hostId: "workbench-gui-host",
    },
    name: "statistics.zip",
    length: "4096",
    mime: "application/zip",
  };
  return { archive, installation, initiallyInstalled: true };
}

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

async function expectAnalysisLayout(
  result: Locator,
  chart: Locator,
  evidence: Locator,
  wide: boolean,
) {
  await expect
    .poll(async () => {
      const [plot, panel] = await Promise.all([
        chart.boundingBox(),
        evidence.boundingBox(),
      ]);
      return Boolean(
        plot &&
        panel &&
        (wide
          ? panel.x >= plot.x + plot.width
          : panel.y >= plot.y + plot.height),
      );
    })
    .toBe(true);
  expect(
    await result.evaluate((element) => {
      const { left, right } = element.getBoundingClientRect();
      return (
        left >= 0 &&
        right <= window.innerWidth &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
  ).toBe(true);
}

test("professional XY displays the verified result and inspects calibrated sample origins", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1240, height: 840 });
  const stats: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../packages/plugin-sdk/examples/reference-statistics/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!validateNodePackageManifest(stats))
    throw new Error("Invalid statistics manifest");
  const action = stats.contributes.actions.find(
    ({ actionId }) => actionId === "swb.reference.statistics.alignXY",
  );
  if (!action) throw new Error("Missing professional XY action");
  const verifiedSource = {
    source: source.source,
    keyId: source.keyId,
    publicKeySha256,
  };
  const fileRef = {
    kind: "plugin_result",
    id: "aligned-xy-report",
    hostId: "workbench-gui-host",
  };
  const reportFile = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      fileRef,
      offset: "0",
      nextOffset: String(bytes.length),
      totalBytes: String(bytes.length),
      bytesBase64: bytes.toString("base64"),
      atEnd: true,
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  await seedWorkbenchFixture(page, {
    language: "en",
    theme: "light",
    sidebarCollapsed: true,
    plugin: {
      ...terminalPlugin(),
      initiallyInstalled: true,
      installation: {
        manifest: stats,
        archiveSha256,
        enabled: true,
        verifiedSource,
        executionTrust: {
          archiveSha256,
          permissions: stats.permissions,
          verifiedSource,
        },
      },
    },
    framing: {
      action,
      page: reportFile(null),
      dependencies: [
        { id: stats.id, version: stats.version, digest: archiveSha256 },
      ],
    },
  });
  await page.goto("./#/plugins");
  await page
    .getByRole("button", {
      name: /Sample Window Statistics and XY Alignment.*Enabled/,
    })
    .click();
  const panel = page.getByRole("region", { name: "Cross-source XY" });
  const input = panel.getByRole("textbox", { name: "Analysis input (JSON)" });
  await panel.getByRole("button", { name: "Load Lissajous example" }).click();
  const example: unknown = JSON.parse(await input.inputValue());
  const report = alignXY(example, new AbortController().signal);
  await page.evaluate(
    (result) => window.workbenchFixture.setFramingResult(result),
    reportFile(report),
  );
  await panel.getByRole("button", { name: "Align channels" }).click();
  const result = panel.getByRole("region", { name: "Alignment result" });
  await expect(
    result.getByText("33 paired points out of 33 X samples"),
  ).toBeVisible();
  await expect(result.getByText("32000 / 32032")).toBeVisible();
  const sample = result.getByRole("spinbutton", { name: "X sample number" });
  await sample.focus();
  await sample.press("ArrowUp");
  await expect(result.getByText("Interpolated", { exact: true })).toBeVisible();
  await expect(result.getByText(/X #2.*51000 ns/)).toBeVisible();
  await expect(result.getByText(/Y #1.*20000 ns/)).toBeVisible();
  await expect(result.getByText(/Y #2.*22002 ns/)).toBeVisible();
  await expect(result.getByText(/32032000\/64064000/)).toBeVisible();
  const trace = result.locator("[data-xy-trace]");
  await expect(trace).toHaveCount(1);
  await result.getByRole("button", { name: "Scatter", exact: true }).click();
  await expect(trace).toHaveCount(0);
  await result.getByRole("button", { name: "Connected", exact: true }).click();
  await expect(trace).toHaveCount(1);
  const plot = result.getByRole("figure");
  await expectAnalysisLayout(result, plot, sample, true);
  await result.screenshot({ path: testInfo.outputPath("professional-xy.png") });
  await page.setViewportSize({ width: 400, height: 690 });
  await expectAnalysisLayout(result, plot, sample, false);
  await result.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await page.screenshot({
    path: testInfo.outputPath("professional-xy-narrow.png"),
    animations: "disabled",
  });

  const corrupt = { ...reportFile(report), fingerprint: "0".repeat(64) };
  await page.evaluate(
    (value) => window.workbenchFixture.setFramingResult(value),
    corrupt,
  );
  await panel.getByRole("button", { name: "Align channels" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Couldn’t read a verified report",
  );
  await expect(result).toHaveCount(0);
  await input.fill("[]");
  await panel.getByRole("button", { name: "Align channels" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Enter a valid JSON object",
  );
  await expect(input).toBeFocused();
  const calls = await page.evaluate(() =>
    window.workbenchFixture.invocations.filter(
      ({ actionId }) => actionId === "swb.reference.statistics.alignXY",
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    target: { kind: "host", id: fileRef.hostId },
    params: example,
  });
});

for (const { language, theme } of [
  { language: "en", theme: "light" },
  { language: "zh", theme: "dark" },
] as const) {
  test(`professional spectrum shows window peaks, missing waterfall rows and histogram counts (${language})`, async ({
    page,
  }, testInfo) => {
    const t = createTranslator(getLocale(language).messages);
    await page.setViewportSize({ width: 1240, height: 840 });
    const plugin = statisticsPlugin();
    const { manifest, archiveSha256 } = plugin.installation;
    const action = manifest.contributes.actions.find(
      ({ actionId }) => actionId === "swb.reference.statistics.spectrum",
    );
    if (!action) throw new Error("Missing spectrum action");
    const reference = {
      kind: "plugin_result",
      id: "spectrum-result",
      hostId: "workbench-gui-host",
    };
    function reportFile(value: unknown) {
      const bytes = Buffer.from(JSON.stringify(value));
      return {
        fileRef: reference,
        offset: "0",
        nextOffset: String(bytes.length),
        totalBytes: String(bytes.length),
        bytesBase64: bytes.toString("base64"),
        atEnd: true,
        fingerprint: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    await seedWorkbenchFixture(page, {
      language,
      theme,
      sidebarCollapsed: true,
      plugin,
      framing: {
        action,
        page: reportFile(null),
        dependencies: [
          { id: manifest.id, version: manifest.version, digest: archiveSha256 },
        ],
      },
    });
    await page.goto("./#/plugins");
    await page
      .getByRole("button", {
        name: /Sample Window Statistics and XY Alignment/,
      })
      .click();
    await page.getByText(t("plugins.spectrum.title"), { exact: true }).click();
    const panel = page.getByRole("region", {
      name: t("plugins.spectrum.title"),
    });
    await panel
      .getByRole("button", { name: t("plugins.spectrum.example") })
      .click();
    const draft = panel.getByRole("textbox", {
      name: t("plugins.spectrum.input"),
    });
    const clock = "recorder-" + "0123456789".repeat(5);
    await draft.fill(
      (await draft.inputValue()).replace("example-clock", clock),
    );
    const input: unknown = JSON.parse(await draft.inputValue());
    const output = spectrum(input, new AbortController().signal);
    await page.evaluate(
      (file) => window.workbenchFixture.setFramingResult(file),
      reportFile(output),
    );
    await panel
      .getByRole("button", { name: t("plugins.spectrum.run") })
      .click();
    const result = panel.getByRole("region", {
      name: t("plugins.spectrum.result"),
    });
    await expect(result.getByRole("status")).toContainText("1,000 Hz");
    await expect(result.getByRole("status")).toContainText("16/24");
    await expect(
      result.getByRole("img", { name: t("plugins.spectrum.waterfallImage") }),
    ).toBeVisible();
    await expect(
      result.getByRole("img", { name: t("plugins.spectrum.spectrumImage") }),
    ).toBeVisible();
    await expect(
      result.getByText("250 Hz · 6.021 dB", { exact: true }),
    ).toBeVisible();
    const waterfall = result.getByRole("region", {
      name: t("plugins.spectrum.waterfall"),
    });
    const histogram = result.getByRole("region", {
      name: t("plugins.spectrum.histogram"),
    });
    await expectAnalysisLayout(result, waterfall, histogram, true);
    await expect(result.getByRole("status")).toContainText(clock);
    await expect(
      histogram.getByRole("row", { name: /0–1/ }).getByRole("cell"),
    ).toHaveText("4");
    const frequency = result.getByRole("combobox", {
      name: t("plugins.spectrum.selectBin"),
    });
    await expect(frequency).toHaveText(t("plugins.spectrum.noBin"));
    await frequency.click();
    await page.getByRole("option", { name: "125 Hz", exact: true }).click();
    await expect(frequency).toHaveText("125 Hz");
    await frequency.press("Enter");
    await page
      .getByRole("option", { name: t("plugins.spectrum.noBin"), exact: true })
      .click();
    await expect(frequency).toHaveText(t("plugins.spectrum.noBin"));
    await expect(
      result.getByText("250 Hz · 6.021 dB", { exact: true }),
    ).toBeVisible();

    const windowChoice = result.getByRole("combobox", {
      name: t("plugins.spectrum.selectWindow"),
    });
    await windowChoice.click();
    await page
      .getByRole("option", { name: "8000000–16000000 ns", exact: true })
      .click();
    await expect(
      result.getByText("500 Hz · 12.041 dB", { exact: true }),
    ).toBeVisible();
    await result.screenshot({
      path: testInfo.outputPath("professional-spectrum.png"),
    });
    await page.setViewportSize({ width: 400, height: 690 });
    await expectAnalysisLayout(result, waterfall, histogram, false);
    await result.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await page.screenshot({
      path: testInfo.outputPath("professional-spectrum-narrow.png"),
      animations: "disabled",
    });
    await histogram.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await page.screenshot({
      path: testInfo.outputPath("professional-histogram-narrow.png"),
      animations: "disabled",
    });
    await windowChoice.click();
    await page
      .getByRole("option", { name: "16000000–24000000 ns", exact: true })
      .click();
    await expect(
      result.getByText(
        t("plugins.spectrum.windowStatus", {
          state: t("plugins.spectrum.status.empty"),
          from: "17",
          to: "25",
          missing: 8,
        }),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      result.getByRole("img", { name: t("plugins.spectrum.spectrumImage") }),
    ).toHaveCount(0);

    const calls = await page.evaluate(() =>
      window.workbenchFixture.invocations.filter(
        ({ actionId }) => actionId === "swb.reference.statistics.spectrum",
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { kind: "host", id: reference.hostId },
      params: input,
    });
  });
}

test("professional window statistics distinguishes missing samples from unscheduled time slots", async ({
  page,
}, testInfo) => {
  const t = createTranslator(getLocale("zh").messages);
  await page.setViewportSize({ width: 400, height: 640 });
  const plugin = statisticsPlugin();
  const { manifest, archiveSha256 } = plugin.installation;
  const action = manifest.contributes.actions.find(
    ({ actionId }) => actionId === "swb.reference.statistics.windows",
  );
  if (!action) throw new Error("Missing statistical windows action");
  const fileRef = {
    kind: "plugin_result",
    id: "windows-result",
    hostId: "workbench-gui-host",
  };
  const file = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      fileRef,
      offset: "0",
      nextOffset: String(bytes.length),
      totalBytes: String(bytes.length),
      bytesBase64: bytes.toString("base64"),
      atEnd: true,
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  await seedWorkbenchFixture(page, {
    language: "zh",
    theme: "dark",
    sidebarCollapsed: true,
    plugin,
    framing: {
      action,
      page: file(null),
      dependencies: [
        { id: manifest.id, version: manifest.version, digest: archiveSha256 },
      ],
    },
  });
  await page.goto("./#/plugins");
  await page
    .getByRole("button", { name: /Sample Window Statistics and XY Alignment/ })
    .click();
  await page.getByText(t("plugins.windows.title"), { exact: true }).click();
  const panel = page.getByRole("region", { name: t("plugins.windows.title") });
  const settings = panel.getByRole("group", {
    name: t("plugins.windows.settings"),
  });
  const sampleGrid = panel.getByRole("textbox", {
    name: t("plugins.windows.input"),
  });
  const run = panel.getByRole("button", { name: t("plugins.windows.run") });
  const result = panel.getByRole("region", {
    name: t("plugins.windows.result"),
  });
  await panel
    .getByRole("button", { name: t("plugins.windows.example") })
    .click();
  const source = await sampleGrid.inputValue();
  await expectAnalysisLayout(panel, sampleGrid, settings, false);
  await page.setViewportSize({ width: 1240, height: 840 });
  const samplesBox = await sampleGrid.boundingBox();
  const settingsBox = await settings.boundingBox();
  if (!samplesBox || !settingsBox)
    throw new Error("Missing window form geometry");
  expect(settingsBox.x).toBeGreaterThan(samplesBox.x + samplesBox.width);
  await page.setViewportSize({ width: 400, height: 640 });

  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected a sample grid object");
  const input = {
    ...parsed,
    window: { kind: "count", length: "2", step: "1" },
  };
  const countReport = summarize(input, new AbortController().signal);
  await page.evaluate(
    (report) => window.workbenchFixture.setFramingResult(report),
    file(countReport),
  );
  await run.click();
  await expect(result.getByRole("status")).toContainText("[5, 9)");
  await expect(result.getByText("1 / 2 · 50%", { exact: true })).toBeVisible();
  await result.getByText(t("plugins.windows.compare"), { exact: true }).click();
  const comparison = result.getByRole("table", {
    name: t("plugins.windows.compare"),
  });
  await expect(comparison.getByRole("row")).toHaveCount(5);
  await expect(
    comparison
      .getByRole("row")
      .nth(1)
      .getByRole("cell", { name: "1.25", exact: true })
      .first(),
  ).toBeVisible();
  const compareScroll = result.getByRole("region", {
    name: t("plugins.windows.compare"),
  });
  await compareScroll.focus();
  await compareScroll.press("ArrowRight");
  await expect
    .poll(() => compareScroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(comparison.getByRole("row").last()).toContainText(
    t("plugins.windows.tail"),
  );

  const mode = settings.getByRole("combobox", {
    name: t("plugins.windows.kind"),
  });
  await mode.click();
  await page
    .getByRole("option", { name: t("plugins.windows.time"), exact: true })
    .click();
  await expect(result).toHaveCount(0);
  const origin = 18000000000000000000n;
  const time = {
    kind: "time",
    length: "4",
    step: "3",
    clockId: "recorder-" + "0123456789".repeat(5),
    originMonoNs: String(origin),
    periodNs: "10",
  };
  for (const field of [
    "length",
    "step",
    "clockId",
    "originMonoNs",
    "periodNs",
  ] as const) {
    await settings
      .getByRole("textbox", { name: t(`plugins.windows.${field}`) })
      .fill(time[field]);
  }
  const timedInput = { ...input, window: time };
  const timeReport = summarize(timedInput, new AbortController().signal);
  await page.evaluate(
    (report) => window.workbenchFixture.setFramingResult(report),
    file(timeReport),
  );
  await run.click();
  await expect(result.getByRole("status")).toContainText(time.clockId);
  const selected = result.getByRole("region", {
    name: t("plugins.windows.selected"),
  });
  await expect(
    selected.getByText("1.25", { exact: true }).first(),
  ).toBeVisible();
  const chooser = result.getByRole("combobox", {
    name: t("plugins.windows.selected"),
  });

  async function selectWindow(number: number, from: bigint, to: bigint) {
    await chooser.press("Enter");
    await page
      .getByRole("option", {
        name: t("plugins.windows.windowNumber", { number }),
        exact: true,
      })
      .click();
    await expect(
      selected.getByText(`[${origin + from}, ${origin + to}) ns`, {
        exact: true,
      }),
    ).toBeVisible();
  }

  await selectWindow(2, 3n, 7n);
  await expect(result.getByText(t("plugins.windows.noSlots"))).toBeVisible();
  await expect(result.getByText("0 / 0 · —", { exact: true })).toBeVisible();
  await selectWindow(4, 9n, 13n);
  await expect(result.getByText(t("plugins.windows.noSamples"))).toBeVisible();
  await expect(result.getByText("1 / 1 · 100%", { exact: true })).toBeVisible();
  await selectWindow(14, 39n, 40n);
  await expect(
    result
      .getByRole("region", { name: t("plugins.windows.selected") })
      .getByText(t("plugins.windows.tail"), { exact: true }),
  ).toBeVisible();
  await selected.screenshot({
    path: testInfo.outputPath("statistics-window-narrow.png"),
  });

  const corrupt = {
    ...timeReport,
    windows: timeReport.windows.map((entry, index) =>
      index === 1 ? { ...entry, missingRate: 1 } : entry,
    ),
  };
  await page.evaluate(
    (report) => window.workbenchFixture.setFramingResult(report),
    file(corrupt),
  );
  await run.click();
  await expect(panel.getByRole("alert")).toHaveText(
    t("plugins.windows.failed"),
  );
  await expect(result).toHaveCount(0);
  const calls = await page.evaluate(() =>
    window.workbenchFixture.invocations.filter(
      ({ actionId }) => actionId === "swb.reference.statistics.windows",
    ),
  );
  expect(calls).toHaveLength(3);
  expect(calls[1]).toMatchObject({
    target: { kind: "host", id: fileRef.hostId },
    params: timedInput,
  });
});
