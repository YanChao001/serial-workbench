import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { NativePage, ResourceError } from "@/components/native-page";
import { HelpTooltip } from "@/components/help-tooltip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/providers/i18n";
import { useNativeResource } from "@/hooks/use-native-resource";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import { errorMessage, nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import { copyText } from "@/lib/clipboard";
import {
  recoveryStatus,
  stageRecovery,
  relaunchApp,
  getDiagnosticsReport,
  isTauri,
} from "@/lib/tauri";

function RecoveryRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("section", "recovery");
  return <Navigate to={`/settings?${params.toString()}`} replace />;
}

export function RecoveryContent({
  standalone = false,
}: {
  standalone?: boolean;
}) {
  const { t } = useI18n();
  const latest = useLatestTranslator();
  const load = useCallback(() => recoveryStatus(), []);
  const { data: status, error: statusError, reload } = useNativeResource(load);
  const [error, setError] = useState<unknown>(null);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const notifiedStatusError = useRef<unknown>(null);
  const pending = status?.pending || scheduled;
  const reportError = useCallback(
    (reason: unknown) => {
      setError(reason);
      if (isRecord(reason) && reason.code === "STORAGE_CORRUPT") {
        setRecoveryError(reason);
      }
      toast.error(nativeErrorText(reason, latest));
    },
    [latest],
  );
  useEffect(() => {
    if (!statusError) notifiedStatusError.current = null;
    else if (status && notifiedStatusError.current !== statusError) {
      notifiedStatusError.current = statusError;
      toast.error(nativeErrorText(statusError, latest));
    }
  }, [status, statusError, latest]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (mounted.current) reportError(reason);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (standalone && (!isTauri() || (status && !status.active)))
    return <RecoveryRedirect />;

  const content = (
    <>
      <ResourceError
        error={status ? null : statusError}
        retry={() => void reload()}
      />
      {status ? (
        <Card>
          <CardContent className="space-y-3">
            <h3 className="font-semibold">
              {t(status.active ? "recovery.isolated" : "recovery.healthy")}
            </h3>
            {status.active ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("recovery.preserved")}
                </p>
                <div
                  role="region"
                  tabIndex={0}
                  aria-label={t("recovery.isolated")}
                  className="h-36 overflow-y-auto rounded-lg border border-amber-500/40 p-3 text-sm break-words"
                >
                  <p role="alert">{status.reason}</p>
                  {recoveryError ? (
                    <div className="mt-3 space-y-1 border-t pt-3 text-destructive">
                      <p role="alert">{nativeErrorText(recoveryError, t)}</p>
                      {isRecord(recoveryError) &&
                      typeof recoveryError.message === "string" ? (
                        <p className="whitespace-pre-wrap">
                          {errorMessage(recoveryError)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("recovery.noAction")}
              </p>
            )}
            {status.archiveId ? (
              <p
                className="max-h-24 overflow-y-auto text-sm break-all"
                tabIndex={0}
              >
                {t("recovery.archive", { id: status.archiveId })}
              </p>
            ) : null}
            {status.active ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await copyText(
                      JSON.stringify(await getDiagnosticsReport(), null, 2),
                    );
                    if (mounted.current)
                      toast.success(latest("recovery.copied"));
                  })
                }
              >
                {t("recovery.diagnostics")}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {status?.active ? (
        <fieldset
          data-surface="panel"
          className="min-w-0 space-y-3"
          aria-label={t("recovery.schedule")}
        >
          <legend className="max-w-full text-sm font-medium">
            <h3 className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
              {t("recovery.schedule")}
              <HelpTooltip
                label={`${t("recovery.schedule")} · ${t("title.help")}`}
              >
                {t("recovery.scheduleHint")}
              </HelpTooltip>
            </h3>
          </legend>
          {pending ? (
            <>
              <p
                role="status"
                tabIndex={0}
                className="min-w-0 overflow-auto text-sm"
              >
                {t("recovery.pending")}
              </p>
              <Button
                disabled={busy}
                onClick={() => void run(() => relaunchApp())}
              >
                {t("recovery.restart")}
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              {t("recovery.schedule")}
            </Button>
          )}
        </fieldset>
      ) : null}
      {error && error !== recoveryError && !confirm ? (
        <p role="alert" className="sr-only">
          {nativeErrorText(error, t)}
        </p>
      ) : null}
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <DialogContent closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("recovery.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("recovery.confirmWithSettings")}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="sr-only">
              {nativeErrorText(error, t)}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await stageRecovery();
                  if (mounted.current) {
                    setScheduled(true);
                    setRecoveryError(null);
                    setConfirm(false);
                  }
                })
              }
            >
              {t("recovery.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return standalone ? (
    <NativePage
      title={t("recovery.title")}
      description={t("recovery.description")}
    >
      {content}
    </NativePage>
  ) : (
    content
  );
}

export default function Recovery() {
  return <RecoveryContent standalone />;
}
