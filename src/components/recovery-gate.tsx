import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ResourceError } from "@/components/native-page";
import { useI18n } from "@/providers/i18n";
import { isTauri, recoveryStatus, type RecoveryStatus } from "@/lib/tauri";

/** 恢复隔离状态确认前不挂载普通业务页面，避免把临时数据当作正式数据。 */
export function RecoveryGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    void recoveryStatus()
      .then((value) => {
        if (!stopped) {
          setStatus(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(reason);
      });
    return () => {
      stopped = true;
    };
  }, [attempt]);
  if (!isTauri()) return children;
  if (error || !status)
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <section className="studio-panel grid w-full max-w-md gap-4 p-4 sm:p-6">
          <h1 className="text-lg font-semibold">{t("recovery.title")}</h1>
          {error ? (
            <ResourceError
              error={error}
              retry={() => {
                setError(null);
                setAttempt((value) => value + 1);
              }}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t("common.loading")}
            </p>
          )}
        </section>
      </main>
    );
  if (status.active && pathname !== "/recovery" && pathname !== "/diagnostics")
    return <Navigate to="/recovery" replace />;
  return children;
}
