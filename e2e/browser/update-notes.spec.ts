/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  QueryResult,
  RpcRequest,
  SharedSettings,
  WorkspaceDocument,
} from "@serial-workbench/contracts";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import clientDefaults from "../../src/lib/generated/client-defaults.json" with { type: "json" };
import type {
  ClientStateSnapshot,
  ClientWindowState,
  DesktopAttachment,
  DesktopStatus,
  DiagnosticsReport,
  HostSettingsEffectsReceipt,
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
  }: {
    body: string | null;
    language?: "en" | "zh";
    theme?: "light" | "dark";
  },
) {
  const status: UpdateStatus = {
    operationId: 1,
    configured: true,
    available: true,
    currentVersion: "1.0.0",
    endpoint: "https://example.com/latest.json",
    checkedAt: 1730000000000,
    version: "2.0.0",
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
    appVersion: status.currentVersion,
    tauriVersion: "2.0.0",
    platform: "browser-fixture",
    architecture: "test",
    windowLabel: "main",
    settingsRevision: "1",
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
      protocolVersion: "0.1",
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
      appVersion,
      desktop,
      diagnosticsReport,
      windowGeometry,
    }) => {
      let clientSnapshot = initialClientState;
      let nextSubscription = 1;
      const callbacks = new Map<number, (value: unknown) => void>();
      let nextCallback = 1;
      const fixture: UpdateNotesFixture = {
        openedUrls: [],
        unexpectedCommands: [],
        executedHtml: false,
        hostQueries: [],
        clientStateReads: 0,
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
                return args.handler;
              case "plugin:event|unlisten":
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
                return {
                  active: false,
                  reason: null,
                  pending: false,
                  archiveId: null,
                };
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
