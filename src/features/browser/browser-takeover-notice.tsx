import { useRef, useState } from "react";

import type { BrowserTakeoverRequest } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { WorkbenchNotice } from "@/features/workbench/workbench-notice";
import { nativeErrorText } from "@/lib/native-error";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";

function TakeoverDecision({
  request,
  port,
  decide,
}: {
  request: BrowserTakeoverRequest;
  port?: string;
  decide: (id: string, approve: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ error: unknown }>();
  async function respond(approve: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await decide(request.takeoverId, approve);
    } catch (error) {
      setProblem({ error });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <WorkbenchNotice
      noticeKey={request.takeoverId}
      duration={Infinity}
      dismissible={false}
    >
      <div
        role="group"
        aria-label={t("browserTakeover.title")}
        className="grid min-w-0 gap-2"
      >
        <p className="font-medium">{t("browserTakeover.title")}</p>
        {port ? (
          <>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                {t("browserTakeover.port")}
              </dt>
              <dd className="wrap-anywhere">{port}</dd>
              <dt className="text-muted-foreground">
                {t("browserTakeover.client")}
              </dt>
              <dd className="font-mono wrap-anywhere">{request.clientId}</dd>
            </dl>
            <p className="text-sm">{t("browserTakeover.effect")}</p>
          </>
        ) : (
          <p className="text-sm">{t("browserTakeover.missingPort")}</p>
        )}
        {busy && (
          <p role="status" className="text-sm">
            {t("browserTakeover.submitting")}
          </p>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive wrap-anywhere">
            {nativeErrorText(problem.error, t)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-disabled={busy}
            className="aria-disabled:opacity-50"
            onClick={() => void respond(false)}
          >
            {t("browserTakeover.decline")}
          </Button>
          <Button
            size="sm"
            disabled={!port}
            aria-disabled={busy || !port}
            className="aria-disabled:opacity-50"
            onClick={() => void respond(true)}
          >
            {t("browserTakeover.approve")}
          </Button>
        </div>
      </div>
    </WorkbenchNotice>
  );
}

export function BrowserTakeoverNotice() {
  const { state, connection, decideBrowserTakeover } = useHost();
  const request = state.pendingTakeover;
  if (!request || !decideBrowserTakeover || state.status !== "ready")
    return null;
  const port = state.devices.find(
    (device) =>
      device.hostId === request.target.hostId &&
      device.deviceId === request.deviceId,
  )?.systemName;
  return (
    <TakeoverDecision
      key={`${connection?.generation}:${request.takeoverId}`}
      request={request}
      port={port}
      decide={decideBrowserTakeover}
    />
  );
}
