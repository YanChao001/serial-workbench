import { CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/i18n/zh-CN";
import { useI18n } from "@/providers/i18n";

export function PluginError({
  error,
  message = "plugins.loadError",
  retry,
  dismiss,
}: {
  error: unknown;
  message?: MessageKey;
  retry?: () => void;
  dismiss?: () => void;
}) {
  const { t } = useI18n();
  const action = retry ?? dismiss;
  if (!error) return null;
  return (
    <div
      role="alert"
      data-surface="solid"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <CircleAlertIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-destructive"
        />
        {t(message)}
      </span>
      {action ? (
        <Button size="sm" variant="ghost" onClick={action}>
          {t(retry ? "common.retry" : "plugins.dismissError")}
        </Button>
      ) : null}
    </div>
  );
}
