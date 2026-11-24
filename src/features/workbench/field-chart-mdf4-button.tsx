import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { hostSaveChartArtifact, isTauri } from "@/lib/tauri";
import { HostContext } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  mdf4Action,
  mdf4MediaType,
  mdf4Package,
} from "../../../packages/plugin-sdk/examples/reference-mdf4/snapshot";
import type { FieldChartFrame } from "./field-chart-model";
import { fieldChartMdf4 } from "./field-chart-mdf4";
import type { FramingInspection } from "./framing-anomalies-model";

export function FieldChartMdf4({
  inspection,
  entries,
  start,
  primary,
  paired,
  replaySession,
}: {
  inspection: FramingInspection;
  entries: readonly FieldChartFrame[];
  start: number;
  primary: FieldReading;
  paired?: FieldReading;
  replaySession?: Pick<SessionSnapshot, "sessionId" | "sessionEpoch">;
}) {
  const { t } = useI18n();
  const host = useContext(HostContext);
  const connection = host?.connection;
  const identity = replaySession ?? inspection.target;
  const sessionId = identity.sessionId;
  const sessionEpoch = identity.sessionEpoch;
  const available = Boolean(
    isTauri() &&
    connection &&
    !connection.browser &&
    (replaySession ||
      inspection.target.hostId === connection.hostTarget.hostId) &&
    host?.state.sessions.some(
      (session) =>
        session.sessionId === sessionId &&
        session.sessionEpoch === sessionEpoch &&
        session.state === "open",
    ) &&
    host.state.catalog.some(
      (action) =>
        action.actionId === mdf4Action &&
        action.targetKinds.includes("session") &&
        action.outputSchema["x-swb-file-result"] === mdf4MediaType,
    ),
  );
  const selection = useMemo(
    () =>
      available
        ? fieldChartMdf4(
            inspection,
            entries,
            start,
            paired ? [primary, paired] : [primary],
          )
        : undefined,
    [available, inspection, entries, start, primary, paired],
  );
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    selection: typeof selection;
    connection: typeof connection;
    sessionId: string;
    sessionEpoch: string;
    status: "saved" | "error";
  }>();
  useEffect(
    () => () => pending.current?.abort(),
    [connection, sessionId, sessionEpoch, selection],
  );

  if (!available || !selection) return null;
  const status =
    result?.selection === selection &&
    result.connection === connection &&
    result.sessionId === sessionId &&
    result.sessionEpoch === sessionEpoch
      ? result.status
      : undefined;
  const issue =
    selection.status === "range"
      ? t("workbench.fieldChart.mdf4Range")
      : selection.status === "time"
        ? t("workbench.fieldChart.mdf4Time")
        : selection.status === "field"
          ? t("workbench.fieldChart.mdf4Field")
          : undefined;

  async function save() {
    if (
      !host ||
      !connection ||
      !sessionId ||
      !sessionEpoch ||
      selection?.status !== "ready" ||
      pending.current
    )
      return;
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    setResult(undefined);
    const scope = { selection, connection, sessionId, sessionEpoch };
    try {
      const target = {
        kind: "session",
        hostId: connection.hostTarget.hostId,
        id: sessionId,
        sessionId,
        sessionEpoch,
      };
      const accepted = await host.invoke(
        {
          actionId: mdf4Action,
          target,
          params: selection.snapshot,
          executionMode: "independent",
        },
        owner.signal,
      );
      const complete = await host.waitForOperation(accepted, owner.signal);
      owner.signal.throwIfAborted();
      if (
        complete.state !== "succeeded" ||
        complete.actionId !== mdf4Action ||
        complete.target.hostId !== target.hostId ||
        complete.target.sessionId !== target.sessionId ||
        complete.target.sessionEpoch !== target.sessionEpoch ||
        !complete.dependencies?.some(({ id }) => id === mdf4Package)
      )
        throw new Error("MDF4 operation receipt does not match the export");
      if (
        await hostSaveChartArtifact(connection.generation, complete.operationId)
      ) {
        if (!owner.signal.aborted) setResult({ ...scope, status: "saved" });
      }
    } catch {
      if (!owner.signal.aborted) setResult({ ...scope, status: "error" });
    } finally {
      pending.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant="outline"
        disabled={busy || Boolean(issue)}
        onClick={save}
      >
        {t("workbench.fieldChart.exportMdf4")}
      </Button>
      {issue ? <p className="text-muted-foreground">{issue}</p> : null}
      <div aria-live="polite">
        {status === "saved" ? t("workbench.fieldChart.mdf4Saved") : null}
      </div>
      {status === "error" ? (
        <p role="alert" className="text-destructive">
          {t("workbench.fieldChart.mdf4Failed")}
        </p>
      ) : null}
    </div>
  );
}
