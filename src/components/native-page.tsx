import type { ReactNode } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import { isTauri } from "@/lib/tauri";
import { nativeErrorText } from "@/lib/native-error";

export function NativePage({
  title,
  description,
  compact = false,
  children,
}: {
  title: string;
  description?: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="studio-page">
      {compact ? (
        <h1 className="sr-only">{title}</h1>
      ) : title || description ? (
        <div className="studio-intro">
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      {isTauri() ? (
        children
      ) : (
        <section className="studio-panel p-5">
          <h3 className="text-sm font-medium">{t("native.required")}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("native.description")}
          </p>
        </section>
      )}
    </div>
  );
}
export function ResourceError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div
      role="alert"
      data-surface="solid"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
    >
      <span className="flex items-center gap-2">
        <AlertCircleIcon className="size-4 shrink-0 text-destructive" />
        {nativeErrorText(error, t)}
      </span>
      <Button size="sm" variant="outline" onClick={retry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
