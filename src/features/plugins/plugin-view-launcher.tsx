import { useEffect, useId, useRef, useState } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type {
  NodePackageView,
  SessionSnapshot,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PluginError } from "./plugin-error";
import { BrowserPluginView, type BrowserViewOpen } from "./browser-plugin-view";
import {
  hostCloseNodeView,
  hostOpenNodeView,
  hostSaveChartArtifact,
} from "@/lib/tauri";
import { useI18n } from "@/providers/i18n";
import { useHost } from "@/providers/host-context";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "@/lib/host-client";
import { nativeErrorCode } from "@/lib/native-error";

type DerivedFeed = {
  session: string;
  archiveSha256: string;
  operationId: string;
};
const derivedFeeds = new WeakMap<HostConnection, Map<string, DerivedFeed>>();
const chartPackages = ["swb.reference.chart", "swb.builtin.chart"];
const chartFormats = [
  {
    suffix: "exportSvg",
    mime: "image/svg+xml",
    label: "plugins.exportChartSvg",
  },
  { suffix: "exportCsv", mime: "text/csv", label: "plugins.exportChartCsv" },
] as const;

function retiredFeed(reason: unknown) {
  const code = nativeErrorCode(reason);
  return (
    code === "CATALOG_CHANGED" ||
    code === "NOT_FOUND" ||
    code === "UNSUPPORTED_CAPABILITY"
  );
}

function sessionKey(session: SessionSnapshot) {
  return JSON.stringify([session.sessionId, session.sessionEpoch]);
}

export function PluginViewLauncher({
  connection,
  packageId,
  displayName,
  archiveSha256,
  views,
}: {
  connection: HostConnection;
  packageId: string;
  displayName: string;
  archiveSha256: string;
  views: readonly NodePackageView[];
}) {
  const { t, language } = useI18n();
  const { state, invoke, waitForOperation, checkAction } = useHost();
  const id = useId();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [browserView, setBrowserView] = useState<BrowserViewOpen | null>(null);
  const [error, setError] = useState<{
    reason: unknown;
    exporting: boolean;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const available = views.filter((view) =>
    state.catalog.some(
      (action) =>
        action.actionId === view.actionId &&
        action.targetKinds.includes("session"),
    ),
  );
  const sessions = state.sessions.filter((session) => session.state === "open");
  const session =
    sessions.find((session) => sessionKey(session) === selected) ??
    (selected === "" && sessions.length === 1 ? sessions[0] : undefined);
  const exports =
    !connection.browser && chartPackages.includes(packageId)
      ? chartFormats
          .map((format) => ({
            ...format,
            actionId: `${packageId}.${format.suffix}`,
          }))
          .filter(({ actionId, mime }) =>
            state.catalog.some(
              (action) =>
                action.actionId === actionId &&
                action.targetKinds.includes("session") &&
                action.outputSchema["x-swb-file-result"] === mime,
            ),
          )
      : [];
  if (!available.length && !exports.length) return null;

  async function run(
    actionId: string,
    view?: NodePackageView,
    opener?: HTMLElement,
  ) {
    if (!session || pending.current) return;
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    setError(null);
    setSaved(false);
    const sessionIdentity = sessionKey(session);
    const feedKey =
      view?.feed === "derived"
        ? JSON.stringify([packageId, view.id, sessionIdentity])
        : null;
    const remembered = feedKey
      ? derivedFeeds.get(connection)?.get(feedKey)
      : undefined;
    let operationId =
      remembered?.archiveSha256 === archiveSha256
        ? remembered.operationId
        : null;
    const target = {
      kind: "session",
      hostId: connection.hostTarget.hostId,
      id: session.sessionId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    };
    function forgetFeed() {
      const feeds = derivedFeeds.get(connection);
      if (feedKey && feeds?.get(feedKey)?.operationId === operationId)
        feeds.delete(feedKey);
    }
    try {
      if (operationId && connection.browser && view?.feed === "derived") {
        try {
          const access = await checkAction(
            {
              actionId: "node.views.assetRead",
              target: {
                kind: "operation",
                hostId: target.hostId,
                id: operationId,
              },
              params: { viewId: view.id, offset: "0" },
            },
            owner.signal,
          );
          if (!access.allowed)
            throw new HostRequestError({
              code: "PERMISSION_DENIED",
              message: "Plugin view authorization changed",
              retryable: false,
            });
        } catch (reason) {
          if (!retiredFeed(reason)) throw reason;
          forgetFeed();
          operationId = null;
        }
      }
      if (!operationId) {
        const accepted = await invoke(
          {
            actionId,
            target,
            params: {},
            executionMode: feedKey || !view ? "independent" : "interactive",
          },
          owner.signal,
        );
        const operation = await waitForOperation(
          accepted,
          owner.signal,
          feedKey ? "running" : "succeeded",
        );
        owner.signal.throwIfAborted();
        if (
          !operation.dependencies?.some(
            (item) => item.id === packageId && item.digest === archiveSha256,
          )
        )
          throw new ContractValidationError(
            "Plugin archive changed during the operation",
          );
        operationId = operation.operationId;
        if (feedKey) {
          const feeds =
            derivedFeeds.get(connection) ?? new Map<string, DerivedFeed>();
          const openSessions = new Set(sessions.map(sessionKey));
          for (const [key, feed] of feeds) {
            if (!openSessions.has(feed.session)) feeds.delete(key);
          }
          feeds.set(feedKey, {
            session: sessionIdentity,
            archiveSha256,
            operationId,
          });
          derivedFeeds.set(connection, feeds);
        }
      }
      if (!view) {
        const written = await hostSaveChartArtifact(
          connection.generation,
          operationId,
        );
        if (!owner.signal.aborted) setSaved(written);
        return;
      }
      const presentation = {
        title: displayName,
        locale: language,
        dark: document.documentElement.classList.contains("dark"),
      };
      if (connection.browser) {
        setBrowserView({
          title: presentation.title,
          dark: presentation.dark,
          operationId,
          viewId: view.id,
          packageId,
          archiveSha256,
          target,
          opener,
          forgetFeed: feedKey ? forgetFeed : undefined,
        });
        return;
      }
      const opened = await hostOpenNodeView(
        connection.generation,
        operationId,
        view.id,
        presentation,
      );
      if (owner.signal.aborted) await hostCloseNodeView(opened);
    } catch (reason) {
      if (retiredFeed(reason)) forgetFeed();
      if (!owner.signal.aborted) setError({ reason, exporting: !view });
    } finally {
      pending.current = null;
      if (!owner.signal.aborted) setBusy(false);
    }
  }

  if (!sessions.length)
    return (
      <p className="text-sm text-muted-foreground">
        {t("plugins.noViewSession")}
      </p>
    );

  return (
    <div className="grid gap-2">
      <PluginError
        error={error?.reason}
        message={
          error?.exporting ? "plugins.chartExportError" : "plugins.viewError"
        }
        dismiss={() => setError(null)}
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={id} className="text-xs">
            {t("plugins.viewSession")}
          </Label>
          <Select
            disabled={busy}
            value={session ? sessionKey(session) : ""}
            onValueChange={setSelected}
          >
            <SelectTrigger id={id} className="max-w-full">
              <SelectValue placeholder={t("plugins.selectViewSession")} />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((session, index) => {
                const device = state.devices.find(
                  (device) => device.deviceId === session.deviceId,
                );
                return (
                  <SelectItem
                    key={sessionKey(session)}
                    value={sessionKey(session)}
                  >
                    {device?.systemName ??
                      t("plugins.viewSessionNumber", { number: index + 1 })}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        {available.map((view, index) => (
          <Button
            key={view.id}
            size="sm"
            disabled={!session || busy}
            onClick={(event) =>
              void run(view.actionId, view, event.currentTarget)
            }
          >
            {available.length === 1
              ? t("plugins.openView")
              : t("plugins.openViewNumber", { number: index + 1 })}
          </Button>
        ))}
        {exports.map(({ actionId, label }) => (
          <Button
            key={actionId}
            size="sm"
            variant="outline"
            disabled={!session || busy}
            onClick={() => void run(actionId)}
          >
            {t(label)}
          </Button>
        ))}
      </div>
      {browserView ? (
        <BrowserPluginView
          connection={connection}
          view={browserView}
          onClose={() => setBrowserView(null)}
        />
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("plugins.chartSaved")}
        </p>
      ) : null}
    </div>
  );
}
