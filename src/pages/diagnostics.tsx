import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { CopyIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { NativePage, ResourceError } from "@/components/native-page";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/providers/i18n";
import { useLatestTranslator } from "@/hooks/use-latest-translator";
import { useNativeResource } from "@/hooks/use-native-resource";
import { getDiagnosticsReport, saveDiagnosticsJson } from "@/lib/tauri";
import { copyText } from "@/lib/clipboard";
import { nativeErrorText } from "@/lib/native-error";
import { CodeBlock } from "@/components/code-block";
import { RecoveryContent } from "./recovery";
export function DiagnosticsContent() {
  const { t } = useI18n();
  const { search } = useLocation();
  const reportHeading = useId();
  const recovery = useRef<HTMLElement>(null);
  const latest = useLatestTranslator();
  const { data, error, loading, reload } =
    useNativeResource(getDiagnosticsReport);
  const [sharing, setSharing] = useState(false);
  const preview = data ? JSON.stringify(data, null, 2) : undefined;
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (new URLSearchParams(search).get("section") !== "recovery") return;
    recovery.current?.scrollIntoView({ block: "start" });
    recovery.current?.focus({ preventScroll: true });
  }, [search]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function share(action: "copy" | "save") {
    if (!preview || loading || running.current) return;
    running.current = true;
    setSharing(true);
    try {
      if (action === "copy") {
        await copyText(preview);
      } else if (!(await saveDiagnosticsJson(preview))) {
        return;
      }
      if (mounted.current)
        toast.success(
          latest(
            action === "copy" ? "diagnostics.copied" : "diagnostics.saved",
          ),
        );
    } catch (reason) {
      if (mounted.current) toast.error(nativeErrorText(reason, latest));
    } finally {
      running.current = false;
      if (mounted.current) setSharing(false);
    }
  }
  return (
    <>
      <section
        id="diagnostics-recovery"
        ref={recovery}
        tabIndex={-1}
        aria-label={t("recovery.title")}
        className="space-y-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RecoveryContent />
      </section>
      <Card
        role="region"
        aria-labelledby={reportHeading}
        className="@container/report min-w-0"
      >
        <CardHeader className="grid gap-3 @min-[44rem]/report:grid-cols-[minmax(0,1fr)_auto]">
          <div className="grid min-w-0 gap-1">
            <CardTitle id={reportHeading} role="heading" aria-level={3}>
              {t("diagnostics.preview")}
            </CardTitle>
            <p className="text-sm wrap-anywhere text-muted-foreground">
              {t("diagnostics.logs")}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-start gap-2 @min-[44rem]/report:justify-end">
            <Button
              size="sm"
              className="h-auto min-h-8 max-w-full wrap-anywhere whitespace-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              disabled={!data}
              aria-disabled={loading || sharing}
              onClick={() => void share("copy")}
            >
              <CopyIcon />
              {t("diagnostics.copy")}
            </Button>
            <Button
              size="sm"
              className="h-auto min-h-8 max-w-full wrap-anywhere whitespace-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              data-testid="diagnostics-save"
              variant="outline"
              disabled={!data}
              aria-disabled={loading || sharing}
              onClick={() => void share("save")}
            >
              <DownloadIcon />
              {t("diagnostics.save")}
            </Button>
            {data && (
              <Button
                size="sm"
                className="h-auto min-h-8 max-w-full wrap-anywhere whitespace-normal aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                variant="outline"
                aria-disabled={loading || sharing}
                onClick={() => {
                  if (!loading && !running.current) void reload();
                }}
              >
                <RefreshCwIcon />
                {t("diagnostics.refresh")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3">
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("common.loading")}
            </p>
          )}
          <ResourceError
            error={data ? null : error}
            retry={() => void reload()}
          />
          {data && error ? (
            <div
              role="alert"
              className="grid gap-1 rounded-lg border border-destructive/30 p-3 text-sm wrap-anywhere"
            >
              <p className="font-medium">{t("diagnostics.previousReport")}</p>
              <p>{nativeErrorText(error, t)}</p>
            </div>
          ) : null}
          {preview && (
            <details className="min-w-0">
              <summary className="min-h-8 cursor-pointer rounded-sm py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t("diagnostics.details")}
              </summary>
              <CodeBlock
                data-testid="diagnostics-report"
                role="region"
                aria-label={t("diagnostics.details")}
                className="mt-2 max-h-[min(24rem,45dvh)] min-w-0 whitespace-pre-wrap wrap-anywhere"
                code={preview}
                language="json"
              />
            </details>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function Diagnostics() {
  const { t } = useI18n();
  return (
    <NativePage
      title={t("diagnostics.title")}
      description={t("diagnostics.description")}
    >
      <DiagnosticsContent />
    </NativePage>
  );
}
