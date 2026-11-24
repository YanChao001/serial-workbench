import {
  EllipsisIcon,
  ShieldCheckIcon,
  ShieldQuestionMarkIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type {
  NodePackageSourceKey,
  NodePackageSummary,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNativeResource } from "@/hooks/use-native-resource";
import { useI18n } from "@/providers/i18n";
import type { HostConnection } from "@/lib/host-client";
import type { LocalNodeIntent } from "@/lib/tauri";
import { PluginError } from "./plugin-error";
import { PluginViewLauncher } from "./plugin-view-launcher";
import { alignXyAction, statisticsPackage } from "./xy-analysis-model";
import {
  permissionLabels,
  queryNode,
  readNodeInstallation,
  type Confirmation,
} from "./node-management";

import { spectrumAction } from "./spectrum-report";

const XyAnalysis = lazy(() => import("./xy-analysis"));
const SpectrumAnalysis = lazy(() => import("./spectrum-analysis"));

export function PackageDetails({
  connection,
  summary,
  revision,
  sources,
  blocked,
  run,
  confirm,
}: {
  connection: HostConnection;
  summary: NodePackageSummary;
  revision: string;
  sources: readonly NodePackageSourceKey[];
  blocked: boolean;
  run: (intent: LocalNodeIntent) => void;
  confirm: (confirmation: Confirmation) => void;
}) {
  const { t } = useI18n();
  const { id, archiveSha256, enabled, executionApproved } = summary;
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    return () => owner.abort();
  }, []);
  const load = useCallback(async () => {
    const signal = lifetime.current?.signal;
    const installation = await readNodeInstallation(
      { id, archiveSha256, expectedRevision: revision },
      async (params, signal) => {
        const result = await queryNode(
          connection,
          "node.packages.detailsRead",
          { ...params },
          signal,
        );
        if (result.kind !== "node_package_details")
          throw new ContractValidationError();
        return result.value;
      },
      signal,
    );
    const runtime = await queryNode(
      connection,
      "node.packages.runtime",
      { id },
      signal,
    );
    if (runtime.kind !== "node_package_runtime" || runtime.value.id !== id)
      throw new ContractValidationError();
    return { installation, runtime: runtime.value };
  }, [connection, id, archiveSha256, revision]);
  const { data, error, loading, reload } = useNativeResource(
    load,
    connection.browser ? true : undefined,
  );
  const manifest = data?.installation.manifest;
  const name =
    manifest?.displayName ?? summary.displayName ?? t("plugins.unnamed");
  const version = manifest?.version ?? summary.version;
  const identity = version
    ? `${name} · ${t("plugins.version", { version })}`
    : name;
  const runtime = data?.runtime;
  const phase =
    runtime?.archiveSha256 === archiveSha256 ? runtime.phase : undefined;
  const transitional = phase === "starting" || phase === "stopping";
  useEffect(() => {
    if (!transitional || blocked || loading || error) return;
    const timer = window.setTimeout(() => void reload(), 1000);
    return () => window.clearTimeout(timer);
  }, [transitional, blocked, loading, error, reload]);

  const source = data?.installation.verifiedSource;
  const bundled = source?.source === "swb.product";
  const verified =
    source &&
    sources.some(
      (key) =>
        key.approved &&
        key.source === source.source &&
        key.keyId === source.keyId &&
        key.publicKeySha256 === source.publicKeySha256,
    );
  const sourceLabel = bundled
    ? t("plugins.bundledSource")
    : source
      ? t(
          verified ? "plugins.verifiedSource" : "plugins.sourceNoLongerTrusted",
          {
            source: source.source,
          },
        )
      : t("plugins.unverified");
  const params = { id, archiveSha256 };
  const canConfirmTrust = !blocked && !loading && !error && manifest;
  const status =
    phase === "starting"
      ? "plugins.starting"
      : phase === "stopping"
        ? "plugins.stopping"
        : enabled && phase === "failed"
          ? "plugins.failed"
          : null;

  function setEnabled(next: boolean) {
    run({
      kind: "setEnabled",
      expectedRevision: revision,
      params: { ...params, enabled: next },
    });
  }

  return (
    <div className="space-y-3 border-t border-border/60 bg-muted/25 px-4 py-4 sm:ps-[4.5rem] sm:pe-6">
      {manifest?.description ? (
        <p className="max-w-prose wrap-anywhere text-sm">
          {manifest.description}
        </p>
      ) : null}
      {data ? (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {verified || bundled ? (
            <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0" />
          ) : (
            <ShieldQuestionMarkIcon
              aria-hidden="true"
              className="size-4 shrink-0"
            />
          )}
          <span className="wrap-anywhere">{sourceLabel}</span>
        </p>
      ) : null}
      {!data && loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(status)}
        </p>
      ) : null}
      <PluginError error={error} retry={() => void reload()} />

      {manifest &&
      runtime &&
      !blocked &&
      enabled &&
      executionApproved &&
      (!connection.browser || verified) &&
      phase === "active" ? (
        <PluginViewLauncher
          key={JSON.stringify([archiveSha256, runtime.generation])}
          connection={connection}
          packageId={id}
          displayName={name}
          archiveSha256={archiveSha256}
          views={manifest.contributes.views}
        />
      ) : null}

      {manifest &&
      runtime &&
      !blocked &&
      enabled &&
      executionApproved &&
      (!connection.browser || verified) &&
      phase === "active" &&
      id === statisticsPackage ? (
        <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
          {manifest.contributes.actions.some(
            (action) =>
              action.actionId === alignXyAction &&
              action.targetKinds.includes("host"),
          ) ? (
            <XyAnalysis
              key={JSON.stringify([
                alignXyAction,
                archiveSha256,
                runtime.generation,
              ])}
              target={connection.hostTarget}
              archiveSha256={archiveSha256}
            />
          ) : null}
          {manifest.contributes.actions.some(
            (action) =>
              action.actionId === spectrumAction &&
              action.targetKinds.includes("host"),
          ) ? (
            <SpectrumAnalysis
              key={JSON.stringify([
                spectrumAction,
                archiveSha256,
                runtime.generation,
              ])}
              target={connection.hostTarget}
              archiveSha256={archiveSha256}
            />
          ) : null}
        </Suspense>
      ) : null}

      {!connection.browser ? (
        <div className="flex flex-wrap items-center gap-2">
          {!executionApproved ? (
            <Button
              size="sm"
              disabled={!canConfirmTrust}
              onClick={() => {
                if (!canConfirmTrust) return;
                confirm({
                  label: "plugins.confirmExecution",
                  description: "plugins.confirmExecutionDescription",
                  identity,
                  source: sourceLabel,
                  permissions: permissionLabels(manifest.permissions),
                  intent: {
                    kind: "confirmExecutionTrust",
                    expectedRevision: revision,
                    params,
                  },
                });
              }}
            >
              {t("plugins.confirmExecution")}
            </Button>
          ) : !enabled || phase === "failed" ? (
            <Button
              size="sm"
              disabled={blocked || transitional}
              onClick={() => setEnabled(true)}
            >
              {t(enabled ? "plugins.retryActivation" : "plugins.enable")}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={blocked}>
                <EllipsisIcon aria-hidden="true" />
                {t("plugins.moreActions")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {enabled ? (
                <DropdownMenuItem onSelect={() => setEnabled(false)}>
                  {t("plugins.disable")}
                </DropdownMenuItem>
              ) : null}
              {executionApproved ? (
                <DropdownMenuItem
                  onSelect={() =>
                    confirm({
                      label: "plugins.revokeExecution",
                      description: "plugins.revokeExecutionDescription",
                      identity,
                      intent: {
                        kind: "revokeExecutionTrust",
                        expectedRevision: revision,
                        params,
                      },
                    })
                  }
                >
                  {t("plugins.revokeExecution")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={loading}
                onSelect={() => void reload()}
              >
                {t("plugins.refreshDetails")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  confirm({
                    label: "plugins.uninstall",
                    description: "plugins.uninstallDescription",
                    identity,
                    intent: {
                      kind: "uninstall",
                      expectedRevision: revision,
                      params,
                    },
                  })
                }
              >
                {t("plugins.uninstall")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
}
