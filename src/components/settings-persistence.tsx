import { useId } from "react";
import { AlertCircleIcon } from "lucide-react";
import { useSettings } from "@/providers/settings";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { WorkbenchNotice } from "@/features/workbench/workbench-notice";
import { Button } from "@/components/ui/button";
export function SettingsPersistence({
  compact = false,
  showFutureWarning = true,
}: {
  compact?: boolean;
  showFutureWarning?: boolean;
}) {
  const {
    persistence,
    persistenceError,
    persistenceScope,
    persistenceEventKey,
    retrySave,
    connections,
  } = useSettings();
  const { t } = useI18n();
  const failed = persistence === "error" && persistenceScope !== "connection";
  const instance = useId();
  useUnsavedWork({
    id: `connection-defaults-${instance}`,
    label: t("workbench.tools.parameters"),
    dirty: compact && !!connections?.dirty,
    save: connections?.flush,
    discard: connections?.discard ?? (() => {}),
  });
  const busy = persistence === "loading" || persistence === "saving";
  const future = failed && persistenceError === "FUTURE_FORMAT";
  const eventKey =
    persistenceScope === "shared" ? persistenceEventKey : undefined;
  if (compact)
    return (
      <WorkbenchNotice
        noticeKey={`${persistenceScope ?? "settings"}:${persistenceError ?? ""}`}
        eventKey={eventKey}
        log={{
          module: "settings",
          level: "error",
          message: t(
            future ? "settings.persistenceFuture" : "settings.persistenceError",
          ),
          code: persistenceError ?? undefined,
        }}
      >
        {failed ? (
          <>
            <span role="alert">
              {t(
                future
                  ? "settings.persistenceFuture"
                  : "settings.persistenceError",
              )}
            </span>
            {!future && (
              <Button size="sm" variant="ghost" onClick={retrySave}>
                {t("common.retry")}
              </Button>
            )}
          </>
        ) : null}
      </WorkbenchNotice>
    );
  if (!failed)
    return busy ? (
      <span role="status" className="sr-only">
        {t(
          persistence === "loading"
            ? "settings.persistenceLoading"
            : "settings.persistenceSaving",
        )}
      </span>
    ) : null;
  if (!future)
    return (
      <span role="status" className="sr-only">
        {t("settings.persistenceError")}
      </span>
    );
  if (!showFutureWarning) return null;
  return (
    <div
      role="alert"
      data-surface="solid"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-xs"
    >
      <span className="flex items-center gap-2">
        <AlertCircleIcon className="size-4 shrink-0 text-destructive" />
        {t("settings.persistenceFuture")}
      </span>
    </div>
  );
}

/** 设置页固定工具区保留恢复入口，不依赖短暂通知的显示顺序或寿命。 */
export function SettingsPersistenceRetry() {
  const { persistence, persistenceError, persistenceScope, retrySave } =
    useSettings();
  const { t } = useI18n();
  if (
    persistence !== "error" ||
    persistenceScope === "connection" ||
    persistenceError === "FUTURE_FORMAT"
  )
    return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="shrink-0"
      onClick={retrySave}
    >
      {t("common.retry")}
    </Button>
  );
}
