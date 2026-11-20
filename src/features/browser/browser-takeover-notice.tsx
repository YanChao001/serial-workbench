import { useRef, useState } from "react";
import { toast } from "sonner";
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
  async function respond(approve: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await decide(request.takeoverId, approve);
    } catch (error) {
      toast.error(nativeErrorText(error, t));
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
      <p>
        {port
          ? t("browserTakeover.request", { port, client: request.clientId })
          : t("browserTakeover.missingPort")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void respond(false)}
        >
          {t("browserTakeover.decline")}
        </Button>
        <Button
          size="sm"
          disabled={busy || !port}
          onClick={() => void respond(true)}
        >
          {t("browserTakeover.approve")}
        </Button>
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
