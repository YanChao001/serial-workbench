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
import { hostCloseNodeView, hostOpenNodeView } from "@/lib/tauri";
import { useI18n } from "@/providers/i18n";
import { useHost } from "@/providers/host-context";
import type { HostConnection } from "@/lib/host-client";

type DerivedFeed = { key: string; operationId: string };
const derivedFeeds = new WeakMap<HostConnection, Map<string, DerivedFeed>>();

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
  const { state, invoke, waitForOperation } = useHost();
  const id = useId();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  if (!available.length) return null;

  async function open(view: NodePackageView) {
    if (!session || pending.current) return;
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    setError(null);
    const feedKey =
      view.feed === "derived"
        ? JSON.stringify([archiveSha256, sessionKey(session), view.id])
        : null;
    const remembered = feedKey && derivedFeeds.get(connection)?.get(packageId);
    let operationId =
      remembered && remembered.key === feedKey ? remembered.operationId : null;
    try {
      if (!operationId) {
        const accepted = await invoke(
          {
            actionId: view.actionId,
            target: {
              kind: "session",
              hostId: connection.hostTarget.hostId,
              id: session.sessionId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
            },
            params: {},
            executionMode: feedKey ? "independent" : "interactive",
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
            "Plugin archive changed while opening a view",
          );
        operationId = operation.operationId;
        if (feedKey) {
          const feeds =
            derivedFeeds.get(connection) ?? new Map<string, DerivedFeed>();
          feeds.set(packageId, { key: feedKey, operationId });
          derivedFeeds.set(connection, feeds);
        }
      }
      const opened = await hostOpenNodeView(
        connection.generation,
        operationId,
        view.id,
        {
          title: displayName,
          locale: language,
          dark: document.documentElement.classList.contains("dark"),
        },
      );
      if (owner.signal.aborted) await hostCloseNodeView(opened);
    } catch (reason) {
      const feeds = derivedFeeds.get(connection);
      if (feedKey && feeds?.get(packageId)?.operationId === operationId)
        feeds.delete(packageId);
      if (!owner.signal.aborted) setError(reason);
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
        error={error}
        message="plugins.viewError"
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
            onClick={() => void open(view)}
          >
            {available.length === 1
              ? t("plugins.openView")
              : t("plugins.openViewNumber", { number: index + 1 })}
          </Button>
        ))}
      </div>
    </div>
  );
}
