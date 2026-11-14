import { CircleAlertIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { settingsLocation } from "@/routes";

export function HostConnectionNotice({
  busy,
  title,
  description,
  labels,
  errorCode,
  onRetry,
}: {
  busy: boolean;
  title: string;
  description: string;
  labels: { retry: string; diagnostics: string; code: string };
  errorCode?: string;
  onRetry: () => void;
}) {
  return (
    <div className="workbench-connection-notice">
      <div
        className="workbench-connection-notice-message"
        role={busy ? "status" : "alert"}
      >
        {busy ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
        ) : (
          <CircleAlertIcon aria-hidden="true" />
        )}
        <div>
          <p className="workbench-connection-notice-title">{title}</p>
          <p className="workbench-connection-notice-description">
            {description}
          </p>
        </div>
      </div>
      <div className="workbench-connection-notice-actions">
        <Button size="sm" disabled={busy} onClick={onRetry}>
          <RotateCwIcon aria-hidden="true" />
          {labels.retry}
        </Button>
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={`#${settingsLocation("recovery")}`}
        >
          {labels.diagnostics}
        </a>
        {errorCode && (
          <code
            className="workbench-connection-notice-code"
            title={errorCode}
            aria-label={`${labels.code}: ${errorCode}`}
          >
            {errorCode}
          </code>
        )}
      </div>
    </div>
  );
}
