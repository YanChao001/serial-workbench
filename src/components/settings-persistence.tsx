import { useEffect, useId, useRef } from "react";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { useSettings } from "@/providers/settings";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { recordUserLog } from "@/lib/user-log";
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
  const shown = useRef<string | undefined>(undefined);
  const episode = useRef(0);
  const retry = useRef(retrySave);
  retry.current = retrySave;
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
  useEffect(() => {
    // 由全局常驻的 compact 实例维护提示，页面切换不撤掉仍有效的保存错误。
    if (!compact) return;
    const id = "settings-persistence";
    if (!failed) {
      toast.dismiss(id);
      shown.current = undefined;
      return;
    }
    if (eventKey) {
      // 已验证的后端故障使用同一事件账本，本地磁盘与 RPC 错误仍独立通知。
      toast.dismiss(id);
      shown.current = undefined;
      return;
    }
    const key = `${persistenceScope ?? "settings"}:${persistenceError ?? ""}`;
    if (shown.current === key) return;
    shown.current = key;
    recordUserLog(
      {
        module: persistenceScope === "serial" ? "serial" : "settings",
        level: "error",
        message: t(
          future ? "settings.persistenceFuture" : "settings.persistenceError",
        ),
        code: persistenceError ?? undefined,
      },
      `${id}:${instance}:${++episode.current}`,
    );
    toast.error(
      t(future ? "settings.persistenceFuture" : "settings.persistenceError"),
      {
        id,
        duration: 5000,
        closeButton: true,
        ...(future
          ? {}
          : {
              action: {
                label: t("common.retry"),
                onClick: () => retry.current(),
              },
            }),
      },
    );
  }, [
    compact,
    failed,
    future,
    persistenceError,
    persistenceScope,
    eventKey,
    t,
    instance,
  ]);
  if (compact)
    return failed && eventKey ? (
      <WorkbenchNotice
        noticeKey={eventKey}
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
        <span role="alert">
          {t(
            future ? "settings.persistenceFuture" : "settings.persistenceError",
          )}
        </span>
        {!future && (
          <Button size="sm" variant="ghost" onClick={() => retry.current()}>
            {t("common.retry")}
          </Button>
        )}
      </WorkbenchNotice>
    ) : null;
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
