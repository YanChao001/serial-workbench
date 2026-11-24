/// <reference lib="dom" />
import { defaults, clientDefaults } from "./json-fixtures";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { en } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import type {
  QueryResult,
  RpcRequest,
  SharedSettings,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import type {
  ClientStateSnapshot,
  ClientWindowState,
  DesktopAttachment,
  DesktopStatus,
  DiagnosticsReport,
  HostSettingsEffectsReceipt,
  RecoveryStatus,
  UpdateProgress,
  UpdateStatus,
  WindowGeometry,
} from "../../src/lib/generated/bindings";

type UpdateNotesFixture = {
  openedUrls: string[];
  unexpectedCommands: string[];
  executedHtml: boolean;
  hostQueries: string[];
  clientStateReads: number;
  installCalls: number;
  recoveryCalls: number;
  relaunchCalls: number;
  updateProgress(value: UpdateProgress): void;
  completeInstall(): void;
};

declare global {
  interface Window {
    updateNotesFixture: UpdateNotesFixture;
  }
}

const releaseUrl = "https://example.com/releases/v2.0.0?source=update-notes";
const longReleaseUrl = `https://example.com/releases/${"release-notes-".repeat(24)}`;
const longNotes = [
  "## Release highlights",
  "",
  "A **readable** release with Markdown formatting.",
  "",
  "- Added a release notes dialog.",
  "- Fixed update status presentation.",
  "",
  "1. Review the changes.",
  "2. Install when ready.",
  "",
  "| Change | Result |",
  "| --- | --- |",
  "| Features | A dedicated notes dialog |",
  "| Fixes | Stable layout in a small window |",
  `| Compatibility | \`${"host_contract_".repeat(24)}\` |`,
  "",
  "```json",
  JSON.stringify({
    release: "2.0.0",
    description: "Long code content ".repeat(30),
  }),
  "```",
  "",
  `[Full release details](${releaseUrl})`,
  "",
  `[${longReleaseUrl}](${longReleaseUrl})`,
  "",
  "[Unsafe protocol](javascript:window.updateNotesFixture.executedHtml=true)",
  "",
  "![Remote release illustration](https://release-notes-fixture.invalid/remote.png)",
  "",
  "<script>window.updateNotesFixture.executedHtml = true</script>",
  '<button id="release-notes-raw-html" onclick="window.updateNotesFixture.executedHtml = true">Raw HTML control</button>',
  '<img src="https://release-notes-fixture.invalid/raw.png" onerror="window.updateNotesFixture.executedHtml = true">',
  "",
  ...Array.from({ length: 28 }, (_, index) =>
    [
      `### Change ${index + 1}`,
      "",
      "This release keeps the complete description available inside the dialog. " +
        "Details remain readable while the title and close control stay in view. ".repeat(
          3,
        ),
      "",
    ].join("\n"),
  ),
  "## End of release notes",
].join("\n");

async function seedUpdateFixture(
  page: Page,
  {
    body,
    language = "en",
    theme = "light",
    version = "2.0.0",
    recovery = { active: false, reason: null, pending: false, archiveId: null },
  }: {
    body: string | null;
    language?: "en" | "zh";
    theme?: "light" | "dark";
    version?: string;
    recovery?: RecoveryStatus;
  },
) {
  const status: UpdateStatus = {
    operationId: 1,
    configured: true,
    available: true,
    currentVersion: "1.0.0",
    endpoint: "https://example.com/latest.json",
    checkedAt: 1730000000000,
    version,
    body,
    date: "2026-10-28T00:00:00Z",
  };
  const snapshot: UpdateProgress = {
    operationId: status.operationId,
    stage: "checked",
    downloaded: null,
    total: null,
    status,
    error: null,
  };
  const desktopStatus: DesktopStatus = {
    trayAvailable: true,
    secondaryOpen: false,
    autostartSupported: true,
    runInBackground: false,
  };
  const diagnostics: DiagnosticsReport = {
    formatVersion: "0.1",
    collectedAt: "2026-10-28T00:00:00Z",
    appVersion: status.currentVersion,
    tauriVersion: "2.0.0",
    platform: "browser-fixture",
    architecture: "test",
    windowLabel: "main",
    settingsRevision: "1",
    configuration: {
      language: "en",
      networkMode: "system",
      runInBackground: false,
    },
    desktop: desktopStatus,
    autostartEnabled: false,
    updaterConfigured: status.configured,
    recentLogs: "",
  };
  const viewport = page.viewportSize();
  const geometry: WindowGeometry = {
    width: viewport?.width ?? 1120,
    height: viewport?.height ?? 740,
    minWidth: 880,
    minHeight: 600,
    maxWidth: 1920,
    maxHeight: 1040,
    defaultWidth: 1120,
    defaultHeight: 740,
  };
  const attachment: DesktopAttachment = {
    generation: "1",
    attachment: {
      hostId: "release-notes-host",
      instanceEpoch: "1",
      protocolVersion: "1.0",
      catalogVersion: "1",
      actorId: "release-notes-actor",
      clientId: "release-notes-client",
      requestContext: "fixture-context",
      requestContextAcceptUntil: "2099-01-01T00:00:00Z",
      limits: {
        maxRequestBytes: "1048576",
        maxPageItems: "100",
        maxBatchBytes: "1048576",
        maxReaderQueueBytes: "1048576",
        resultRetentionMs: "60000",
        maxLeaseTtlMs: "60000",
      },
    },
  };
  const hostId = attachment.attachment.hostId;
  const settingsScope = {
    scopeId: "settings.shared",
    target: { hostId, kind: "settings", id: "shared" },
  };
  const workspaceScope = {
    scopeId: "workspace.default",
    target: { hostId, kind: "workspace", id: "default" },
  };
  const settingsDocument = {
    scope: settingsScope,
    document: {
      revision: "1",
      value: {
        ...(defaults.settings as SharedSettings),
        language,
        theme,
        accent: "violet" as const,
        motion: "reduced" as const,
        autoCheckUpdates: false,
      },
    },
  };
  const workspaceDocument = {
    scope: workspaceScope,
    document: { revision: "1", value: defaults.workspace as WorkspaceDocument },
  };
  const queryResults = {
    "state.scopes": {
      kind: "scopes",
      value: { scopes: [settingsScope, workspaceScope] },
    },
    "catalog.list": {
      kind: "catalog",
      value: { catalogVersion: "1", items: [] },
    },
    "device.list": { kind: "devices", value: { devices: [], stale: false } },
    "settings.read": { kind: "settings", value: settingsDocument },
    "workspace.read": { kind: "workspace", value: workspaceDocument },
  } satisfies Record<string, QueryResult>;
  const clientState = {
    formatVersion: "0.1",
    revision: "1",
    state: {
      ...(clientDefaults as ClientWindowState),
      preferences: {
        ...(clientDefaults as ClientWindowState).preferences,
        sidebarCollapsed: geometry.width < 600,
      },
      currentPage: "settings",
    },
  } satisfies ClientStateSnapshot;
  const effects: HostSettingsEffectsReceipt = {
    hostId,
    instanceEpoch: attachment.attachment.instanceEpoch,
    revision: settingsDocument.document.revision,
    effects: { trayLanguage: true, networkMode: true, runInBackground: true },
  };
  // Exercise the production browser UI with controlled IPC, not native behavior.
  await page.addInitScript(
    ({
      hostAttachment,
      hostQueryResults,
      settingsState,
      workspaceState,
      initialClientState,
      settingsEffects,
      updateSnapshot,
      recoveryStatus,
      appVersion,
      desktop,
      diagnosticsReport,
      windowGeometry,
    }) => {
      let clientSnapshot = initialClientState;
      let recoveryState = recoveryStatus;
      let finishInstall: (() => void) | undefined;
      const updateListeners = new Set<number>();
      let nextSubscription = 1;
      const callbacks = new Map<number, (value: unknown) => void>();
      let nextCallback = 1;
      const fixture: UpdateNotesFixture = {
        openedUrls: [],
        unexpectedCommands: [],
        executedHtml: false,
        hostQueries: [],
        clientStateReads: 0,
        installCalls: 0,
        recoveryCalls: 0,
        relaunchCalls: 0,
        updateProgress(payload) {
          for (const id of updateListeners) {
            callbacks.get(id)?.({
              event: "app://update-progress",
              id,
              payload,
            });
          }
        },
        completeInstall() {
          finishInstall?.();
          finishInstall = undefined;
        },
      };
      Object.assign(window, {
        updateNotesFixture: fixture,
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_event: string, id: number) =>
            callbacks.delete(id),
        },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main", windowLabel: "main" },
          },
          transformCallback(callback: (value: unknown) => void) {
            const id = nextCallback++;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          async invoke(command: string, args: Record<string, unknown> = {}) {
            switch (command) {
              case "plugin:event|listen":
                if (
                  args.event === "app://update-progress" &&
                  typeof args.handler === "number"
                )
                  updateListeners.add(args.handler);
                return args.handler;
              case "plugin:event|unlisten":
                if (typeof args.eventId === "number")
                  updateListeners.delete(args.eventId);
                return null;
              case "plugin:notification|register_listener":
              case "plugin:notification|remove_listener":
              case "complete_frontend_startup":
              case "set_window_work_state":
              case "save_workspace_route":
                return null;
              case "plugin:window|is_maximized":
              case "plugin:window|is_fullscreen":
              case "get_autostart_enabled":
                return false;
              case "plugin:app|version":
                return appVersion;
              case "plugin:app|tauri_version":
                return "2.0.0";
              case "host_local_attachment":
              case "host_attachment":
                return hostAttachment;
              case "host_request": {
                const request = args.request as RpcRequest;
                if (request.method !== "action.query") break;
                const query = request.params;
                fixture.hostQueries.push(query.actionId);
                if (query.actionId === "state.snapshot") {
                  const scopeId = query.params.scopeId;
                  const state =
                    scopeId === settingsState.scope.scopeId
                      ? settingsState
                      : scopeId === workspaceState.scope.scopeId
                        ? workspaceState
                        : null;
                  if (!state) break;
                  return {
                    ok: true,
                    result: {
                      kind: "snapshot",
                      value: {
                        hostId: hostAttachment.attachment.hostId,
                        instanceEpoch: hostAttachment.attachment.instanceEpoch,
                        revision: state.document.revision,
                        cursor: {
                          hostId: hostAttachment.attachment.hostId,
                          instanceEpoch:
                            hostAttachment.attachment.instanceEpoch,
                          scopeId,
                          position: "0",
                        },
                        state,
                      },
                    },
                  };
                }
                const result =
                  hostQueryResults[
                    query.actionId as keyof typeof hostQueryResults
                  ];
                if (result) return { ok: true, result };
                break;
              }
              case "host_subscribe":
                return `release-notes-subscription-${nextSubscription++}`;
              case "host_unsubscribe":
                return null;
              case "client_state_read":
                fixture.clientStateReads++;
                return clientSnapshot;
              case "client_state_save":
                if (args.expectedRevision !== clientSnapshot.revision)
                  throw { code: "CONFLICT" };
                clientSnapshot = {
                  ...clientSnapshot,
                  revision: String(BigInt(clientSnapshot.revision) + 1n),
                  state: args.state as ClientStateSnapshot["state"],
                };
                return clientSnapshot;
              case "apply_host_settings_effects":
                return settingsEffects;
              case "get_desktop_status":
                return desktop;
              case "get_diagnostics_report":
                return diagnosticsReport;
              case "get_window_geometry":
                return windowGeometry;
              case "recovery_status":
                return recoveryState;
              case "stage_recovery":
                fixture.recoveryCalls++;
                if (fixture.recoveryCalls === 1)
                  throw { code: "STORAGE_IO", message: "fixture private path" };
                recoveryState = { ...recoveryState, pending: true };
                return recoveryState;
              case "relaunch_app":
                fixture.relaunchCalls++;
                return null;
              case "get_workspace":
                // Shell route restoration still uses this registered command.
                return {
                  routes: { main: `/${clientSnapshot.state.currentPage}` },
                  secondaryOpen: false,
                };
              case "activation_snapshot":
                return [];
              case "get_update_snapshot":
                return updateSnapshot;
              case "download_and_install_update":
                fixture.installCalls++;
                return new Promise<null>((resolve) => {
                  finishInstall = () => resolve(null);
                });
              case "plugin:opener|open_url":
                if (typeof args.url !== "string")
                  throw new Error("Expected an external URL string");
                fixture.openedUrls.push(args.url);
                return null;
            }
            fixture.unexpectedCommands.push(command);
            throw new Error(`Unexpected IPC fixture command: ${command}`);
          },
        },
      });
    },
    {
      hostAttachment: attachment,
      hostQueryResults: queryResults,
      settingsState: settingsDocument,
      workspaceState: workspaceDocument,
      initialClientState: clientState,
      settingsEffects: effects,
      updateSnapshot: snapshot,
      recoveryStatus: recovery,
      appVersion: status.currentVersion,
      desktop: desktopStatus,
      diagnosticsReport: diagnostics,
      windowGeometry: geometry,
    },
  );
}

async function expectNativeFixtureReady(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.updateNotesFixture.hostQueries))
    .toEqual(
      expect.arrayContaining([
        "state.scopes",
        "catalog.list",
        "device.list",
        "workspace.read",
        "settings.read",
        "state.snapshot",
      ]),
    );
  await expect
    .poll(() => page.evaluate(() => window.updateNotesFixture.clientStateReads))
    .toBeGreaterThan(0);
}

for (const theme of ["light", "dark"] as const) {
  test(`long release notes render safely and scroll inside the dialog in ${theme}`, async ({
    page,
  }, testInfo) => {
    const remoteRequests: string[] = [];
    await page.route(
      "https://release-notes-fixture.invalid/**",
      async (route) => {
        remoteRequests.push(route.request().url());
        await route.abort();
      },
    );
    await page.setViewportSize({ width: 880, height: 600 });
    await seedUpdateFixture(page, { body: longNotes, theme });
    await page.goto("./#/settings?section=updates");
    await expectNativeFixtureReady(page);
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    const trigger = page
      .locator("#settings-updates")
      .getByRole("button", { name: "Release notes", exact: true });
    await expect(trigger).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Release highlights", exact: true }),
    ).toHaveCount(0);

    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Release notes · 2.0.0",
      exact: true,
    });
    const notes = dialog.getByRole("region", {
      name: "Release notes",
      exact: true,
    });
    const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
    const title = dialog.getByRole("heading", {
      name: "Release notes · 2.0.0",
      exact: true,
    });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      notes.getByRole("heading", { name: "Release highlights", exact: true }),
    ).toBeVisible();
    await expect(notes.locator("ul > li")).toHaveText([
      "Added a release notes dialog.",
      "Fixed update status presentation.",
    ]);
    await expect(notes.locator("ol > li")).toHaveText([
      "Review the changes.",
      "Install when ready.",
    ]);
    await expect(notes.getByRole("table")).toHaveCount(1);
    await expect(notes.getByRole("columnheader")).toHaveText([
      "Change",
      "Result",
    ]);
    await expect(
      notes.getByRole("cell", { name: "Features", exact: true }),
    ).toHaveCount(1);
    await expect(notes.locator("pre code")).toContainText('"release":"2.0.0"');
    await expect(notes.locator("strong")).toHaveText("readable");
    await page.evaluate(() => document.fonts.ready);

    const layout = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(15);
    expect(layout.top).toBeGreaterThanOrEqual(15);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth - 15);
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight - 15);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    const scrollSize = await viewport.evaluate((element) => ({
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrollSize.height).toBeGreaterThan(100);
    expect(scrollSize.scrollHeight).toBeGreaterThan(scrollSize.height * 2);
    expect(scrollSize.scrollWidth).toBeLessThanOrEqual(scrollSize.width + 1);

    await expect(
      notes.locator("img, script, #release-notes-raw-html"),
    ).toHaveCount(0);
    await expect(
      notes.getByRole("link", { name: "Unsafe protocol" }),
    ).toHaveCount(0);
    await expect(
      notes.getByText("Unsafe protocol", { exact: true }),
    ).toBeVisible();
    await expect(notes.getByText(/Remote release illustration/)).toBeVisible();
    const external = notes.getByRole("link", {
      name: "Full release details",
      exact: true,
    });
    await expect(external).toHaveAttribute("href", releaseUrl);
    await expect(external).toHaveAttribute("rel", "noopener noreferrer");
    await external.click();
    await expect
      .poll(() => page.evaluate(() => window.updateNotesFixture.openedUrls))
      .toEqual([releaseUrl]);
    expect(page.context().pages()).toHaveLength(1);

    const scan = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(scan.violations).toEqual([]);

    await notes.focus();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await notes.press("PageDown");
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      notes.getByRole("heading", {
        name: "End of release notes",
        exact: true,
      }),
    ).toBeInViewport();
    await expect(title).toBeInViewport();
    await expect(close).toBeInViewport();
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("release-notes.png") });

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(remoteRequests).toEqual([]);
    expect(
      await page.evaluate(() => ({
        executedHtml: window.updateNotesFixture.executedHtml,
        unexpectedCommands: window.updateNotesFixture.unexpectedCommands,
      })),
    ).toEqual({ executedHtml: false, unexpectedCommands: [] });
  });
}

for (const fixture of [
  {
    language: "en",
    body: null,
    trigger: "Release notes",
    title: "Release notes · 2.0.0",
    empty: "No notes for this version.",
    close: "Close",
  },
  {
    language: "zh",
    body: " \n\t ",
    trigger: "版本说明",
    title: "版本说明 · 2.0.0",
    empty: "此版本暂无说明。",
    close: "关闭",
  },
] as const) {
  test(`release notes explain an empty body in ${fixture.language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 880, height: 600 });
    await seedUpdateFixture(page, fixture);
    await page.goto("./#/settings?section=updates");
    await expectNativeFixtureReady(page);
    const trigger = page
      .locator("#settings-updates")
      .getByRole("button", { name: fixture.trigger, exact: true });
    await expect(trigger).toBeEnabled();
    await expect(page.getByText(fixture.empty, { exact: true })).toHaveCount(0);
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: fixture.title,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(fixture.empty, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: fixture.trigger, exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: fixture.close, exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(() => window.updateNotesFixture.unexpectedCommands),
    ).toEqual([]);
  });
}

test("narrow updates keep the download stage visible and focus it after confirmation", async ({
  page,
}, info) => {
  const version = "2.0.0+" + "fixturebuild".repeat(12);
  await page.setViewportSize({ width: 400, height: 510 });
  await seedUpdateFixture(page, { body: "Changes", version, theme: "dark" });
  await page.goto("./#/settings?section=updates");
  await expectNativeFixtureReady(page);
  const updates = page.locator("#settings-updates");
  const status = updates.getByRole("status");
  const actions = updates.getByTestId("updates-actions");
  const install = actions.getByRole("button", { name: en["updates.install"] });
  await expect(status).toContainText(version);
  await expect(install).toBeEnabled();
  const [feedback, actionRow] = await Promise.all([
    status.boundingBox(),
    actions.boundingBox(),
  ]);
  if (!feedback || !actionRow) throw new Error("Missing update summary");
  expect(actionRow.y).toBeGreaterThanOrEqual(feedback.y + feedback.height);
  expect(
    await updates.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  const notes = actions.getByRole("button", {
    name: en["updates.releaseNotes"],
  });
  await notes.click();
  const dialog = page.getByRole("dialog", {
    name: en["updates.releaseNotesTitle"].replace("{version}", version),
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await dialog
    .getByRole("button", { name: en["common.close"], exact: true })
    .click();
  await expect(notes).toBeFocused();

  await install.click();
  const confirm = page.getByRole("dialog", {
    name: en["updates.installConfirmTitle"],
  });
  await expect(confirm).toBeVisible();
  expect(
    await page.evaluate(() => window.updateNotesFixture.installCalls),
  ).toBe(0);
  await confirm.getByRole("button", { name: en["updates.install"] }).click();
  await expect(confirm).toBeHidden();
  await expect(status).toBeFocused();
  await expect(install).toBeDisabled();
  const progress = updates.getByRole("progressbar", {
    name: en["updates.install"],
  });
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await page.evaluate(() =>
    window.updateNotesFixture.updateProgress({
      operationId: 1,
      stage: "downloading",
      downloaded: 340,
      total: 1000,
      status: null,
      error: null,
    }),
  );
  await expect(status).toHaveText("Downloading 34%");
  await expect(progress).toHaveAttribute("aria-valuenow", "34");
  await page.screenshot({
    path: info.outputPath("update-download-narrow.png"),
  });
  await page.evaluate(() =>
    window.updateNotesFixture.updateProgress({
      operationId: 1,
      stage: "installing",
      downloaded: null,
      total: null,
      status: null,
      error: null,
    }),
  );
  await expect(status).toHaveText(en["updates.installing"]);
  await expect(progress).toHaveCount(0);
  await expect(install).toBeDisabled();
  await page.evaluate(() => window.updateNotesFixture.completeInstall());
  await expect(status).toHaveText(en["updates.installed"]);
  await expect(
    actions.getByRole("button", { name: en["updates.restart"] }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => window.updateNotesFixture.installCalls),
  ).toBe(1);
  expect(
    await page.evaluate(() => window.updateNotesFixture.unexpectedCommands),
  ).toEqual([]);
});

test("narrow startup recovery shows the error in place and focuses the scheduled restart", async ({
  page,
}, info) => {
  const reason = "测试配置无法读取 " + "C:/fixture-profile/".repeat(28);
  await page.setViewportSize({ width: 410, height: 560 });
  await seedUpdateFixture(page, {
    body: null,
    language: "zh",
    recovery: {
      active: true,
      reason,
      pending: false,
      archiveId: "fixture-archive",
    },
  });
  await page.goto("./#/recovery");
  const explanation = page.getByRole("region", {
    name: zhCN["recovery.isolated"],
  });
  await expect(explanation.getByText(reason)).toBeVisible();
  expect(
    await explanation.evaluate(
      (node) =>
        node.scrollWidth <= node.clientWidth + 1 &&
        node.scrollHeight > node.clientHeight,
    ),
  ).toBe(true);
  const schedule = page.getByRole("button", {
    name: zhCN["recovery.schedule"],
    exact: true,
  });
  await schedule.click();
  const confirm = page.getByRole("dialog", {
    name: zhCN["recovery.confirmTitle"],
  });
  const action = confirm.getByRole("button", {
    name: zhCN["recovery.confirm"],
  });
  await action.click();
  await expect(confirm.getByRole("alert")).toHaveText(zhCN["errors.IO"]);
  await expect(confirm.getByRole("alert")).toBeVisible();
  await expect(action).toBeEnabled();
  await page.screenshot({ path: info.outputPath("recovery-retry-narrow.png") });
  await action.click();
  await expect(confirm).toBeHidden();
  const restart = page.getByRole("button", { name: zhCN["recovery.restart"] });
  await expect(restart).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: zhCN["recovery.pending"] }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.updateNotesFixture.relaunchCalls),
  ).toBe(0);
  await restart.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.updateNotesFixture.relaunchCalls))
    .toBe(1);
  expect(
    await page.evaluate(() => window.updateNotesFixture.recoveryCalls),
  ).toBe(2);
  expect(
    await page.evaluate(() => window.updateNotesFixture.unexpectedCommands),
  ).toEqual([]);
});
