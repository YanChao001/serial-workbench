import {
  ChevronDownIcon,
  FolderOpenIcon,
  PlusIcon,
  PuzzleIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ContractValidationError } from "@serial-workbench/contracts";
import type { NodePackageSourceKey } from "@serial-workbench/contracts";
import { NativePage } from "@/components/native-page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNativeResource } from "@/hooks/use-native-resource";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { hostApplyNodeIntent, type LocalNodeIntent } from "@/lib/tauri";
import type { HostConnection } from "@/lib/host-client";
import { PluginError } from "@/features/plugins/plugin-error";
import { PackageDetails } from "@/features/plugins/package-details";
import { SourceForm } from "@/features/plugins/source-form";
import {
  loadInstalledPlugins,
  loadPluginSources,
  type Confirmation,
} from "@/features/plugins/node-management";
export default function PluginsPage() {
  const { t } = useI18n();
  const { state, connection, refresh } = useHost();
  return (
    <NativePage title={t("nav.plugins")}>
      {state.status === "ready" && connection ? (
        <PluginManager key={connection.generation} connection={connection} />
      ) : state.status === "error" ? (
        <PluginError error={state.error} retry={() => void refresh()} />
      ) : (
        <p role="status">{t("common.loading")}</p>
      )}
    </NativePage>
  );
}

function sourceIdentity(key: NodePackageSourceKey) {
  return JSON.stringify([key.source, key.keyId, key.publicKeySha256]);
}

function sourceLabel(key: NodePackageSourceKey, keys: NodePackageSourceKey[]) {
  return keys.some(
    (other) => other.source === key.source && other.keyId !== key.keyId,
  )
    ? `${key.source} · ${key.keyId}`
    : key.source;
}

function PluginManager({ connection }: { connection: HostConnection }) {
  const { t } = useI18n();
  const { pickFile, waitForOperation } = useHost();
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<
    "plugins.installError" | "plugins.actionError"
  >("plugins.actionError");
  const [installOpen, setInstallOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installedName, setInstalledName] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourcesId = useId();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sourceChoice, setSourceChoice] = useState("local");
  const [sourceFormEpoch, setSourceFormEpoch] = useState(0);
  const sourceSelectId = useId();
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    return () => owner.abort();
  }, []);

  const load = useCallback(async () => {
    const signal = lifetime.current?.signal;
    // The retained details panel also reloads when the page becomes visible.
    // Each reader uses one slot of the Host's shared package read budget.
    const installed = await loadInstalledPlugins(connection, signal);
    const sources = await loadPluginSources(connection, signal);
    return { installed, sources };
  }, [connection]);
  const { data, error, loading, reload } = useNativeResource(load);
  const installed = data?.installed;
  const sources = data?.sources;
  const approved = sources?.keys.filter(({ approved }) => approved) ?? [];
  const selectedSource = approved.find(
    (key) => sourceIdentity(key) === sourceChoice,
  );
  const sourceUnavailable = sourceChoice !== "local" && !selectedSource;
  const blocked = busy || loading || Boolean(error);

  async function run(
    prepare: (signal: AbortSignal) => Promise<LocalNodeIntent | null>,
    isInstall = false,
  ) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current || blocked) return;
    running.current = true;
    setBusy(true);
    setActionError(null);
    setInstalledName(null);
    setActionErrorMessage(
      isInstall ? "plugins.installError" : "plugins.actionError",
    );
    let submitted = false;
    try {
      const intent = await prepare(signal);
      signal.throwIfAborted();
      if (!intent) return;
      submitted = true;
      const initial = await hostApplyNodeIntent(connection.generation, intent);
      signal.throwIfAborted();
      const completed = await waitForOperation(initial, signal);
      const expected =
        intent.kind === "install"
          ? "node_package_installed"
          : intent.kind === "uninstall"
            ? "node_package_uninstalled"
            : intent.kind === "approveSource" || intent.kind === "revokeSource"
              ? "node_source_changed"
              : "node_package_changed";
      if (completed.result?.kind !== expected)
        throw new ContractValidationError();
      if (completed.result.kind === "node_package_installed") {
        const plugin = completed.result.value.package;
        setActiveId(plugin.id);
        setInstalledName(plugin.displayName ?? t("plugins.unnamed"));
      }
      if (intent.kind === "approveSource")
        setSourceFormEpoch((epoch) => epoch + 1);
    } catch (reason) {
      if (!signal.aborted) setActionError(reason);
    } finally {
      if (!signal.aborted && submitted) await reload();
      running.current = false;
      if (!signal.aborted) {
        setBusy(false);
        setInstalling(false);
      }
    }
  }

  function install() {
    if (!installed || sourceUnavailable) return;
    const { revision } = installed;
    void run(async (signal) => {
      const archive = await pickFile("source", signal);
      signal.throwIfAborted();
      if (!archive) return null;
      setInstallOpen(false);
      setInstalling(true);
      return {
        kind: "install",
        expectedRevision: revision,
        params: {
          archiveRef: archive.reference,
          source: selectedSource
            ? {
                kind: "trusted",
                source: selectedSource.source,
                keyId: selectedSource.keyId,
              }
            : { kind: "local" },
        },
      };
    }, true);
  }

  return (
    <div className="max-w-5xl space-y-4">
      <PluginError error={error} retry={() => void reload()} />
      <PluginError
        error={actionError}
        message={actionErrorMessage}
        dismiss={() => setActionError(null)}
      />
      <section
        className="overflow-hidden rounded-xl border border-border"
        data-surface="solid"
        aria-labelledby="installed-plugin-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <h3 id="installed-plugin-heading" className="text-base font-semibold">
            {t("plugins.installed")}
          </h3>
          {installed && sources ? (
            <Dialog open={installOpen} onOpenChange={setInstallOpen}>
              <DialogTrigger asChild>
                <Button disabled={blocked}>
                  <PlusIcon aria-hidden="true" />
                  {t("plugins.install")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>{t("plugins.install")}</DialogTitle>
                  <DialogDescription>
                    {t("plugins.installDescription")}
                  </DialogDescription>
                </DialogHeader>
                {approved.length || sourceUnavailable ? (
                  <div className="grid gap-2">
                    <Label htmlFor={sourceSelectId}>
                      {t("plugins.installSource")}
                    </Label>
                    <Select
                      value={sourceUnavailable ? "" : sourceChoice}
                      onValueChange={setSourceChoice}
                      disabled={blocked}
                    >
                      <SelectTrigger id={sourceSelectId} className="w-full">
                        <SelectValue placeholder={t("plugins.installSource")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">
                          {t("plugins.localFile")}
                        </SelectItem>
                        {approved.map((key) => (
                          <SelectItem
                            key={sourceIdentity(key)}
                            value={sourceIdentity(key)}
                          >
                            {sourceLabel(key, approved)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {sourceUnavailable ? (
                      <p role="alert" className="text-sm text-destructive">
                        {t("plugins.sourceUnavailable")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setInstallOpen(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={blocked || sourceUnavailable}
                    onClick={install}
                  >
                    <FolderOpenIcon aria-hidden="true" />
                    {t("plugins.chooseFile")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>

        <div
          role="status"
          className={
            busy || loading
              ? "border-b border-border px-4 py-2 text-sm text-muted-foreground sm:px-6"
              : "sr-only"
          }
        >
          {busy
            ? t(installing ? "plugins.installing" : "plugins.pending")
            : loading
              ? t("common.loading")
              : installedName
                ? t("plugins.installedMessage", { name: installedName })
                : null}
        </div>

        {installed &&
          sources &&
          (installed.packages.length ? (
            <ul className="divide-y divide-border">
              {installed.packages.map((item) => {
                const expanded = item.id === activeId;
                const status = !item.executionApproved
                  ? "plugins.executionPending"
                  : item.enabled
                    ? "plugins.enabled"
                    : "plugins.disabled";
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-surface="transparent"
                      aria-expanded={expanded}
                      className="plugin-package-row grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-6"
                      onClick={() => setActiveId(expanded ? null : item.id)}
                    >
                      <span className="row-span-2 grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground sm:row-span-1">
                        <PuzzleIcon aria-hidden="true" className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block wrap-anywhere text-sm font-semibold">
                          {item.displayName ?? t("plugins.unnamed")}
                        </span>
                        {item.version ? (
                          <span className="block wrap-anywhere text-xs text-muted-foreground">
                            {t("plugins.version", { version: item.version })}
                          </span>
                        ) : null}
                      </span>
                      <span className="col-start-2 row-start-2 flex items-center gap-1.5 text-xs text-muted-foreground sm:col-auto sm:row-auto">
                        <span
                          aria-hidden="true"
                          className={
                            item.executionApproved && item.enabled
                              ? "size-1.5 rounded-full bg-primary"
                              : "size-1.5 rounded-full bg-current"
                          }
                        />
                        {t(status)}
                      </span>
                      <ChevronDownIcon
                        aria-hidden="true"
                        className={
                          expanded
                            ? "col-start-3 row-span-2 row-start-1 size-4 rotate-180 text-muted-foreground sm:col-auto sm:row-auto"
                            : "col-start-3 row-span-2 row-start-1 size-4 text-muted-foreground sm:col-auto sm:row-auto"
                        }
                      />
                    </button>
                    {expanded ? (
                      <PackageDetails
                        key={JSON.stringify([
                          installed.revision,
                          item.id,
                          item.archiveSha256,
                        ])}
                        connection={connection}
                        summary={item}
                        revision={installed.revision}
                        sources={sources.keys}
                        blocked={blocked}
                        confirm={setConfirmation}
                        run={(intent) => void run(async () => intent)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="grid justify-items-center gap-2 px-4 py-12 text-center sm:py-16">
              <div className="mb-1 grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
                <PuzzleIcon aria-hidden="true" className="size-5" />
              </div>
              <p className="text-sm font-semibold">{t("plugins.empty")}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("plugins.emptyDescription")}
              </p>
            </div>
          ))}
      </section>

      {sources ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-expanded={sourcesOpen}
            aria-controls={sourcesId}
            onClick={() => setSourcesOpen(!sourcesOpen)}
          >
            <ShieldCheckIcon aria-hidden="true" />
            {t("plugins.sources")}
            <ChevronDownIcon
              aria-hidden="true"
              className={sourcesOpen ? "rotate-180" : undefined}
            />
          </Button>
          <section
            id={sourcesId}
            hidden={!sourcesOpen}
            data-surface="solid"
            className="mt-2 space-y-4 rounded-xl border border-border p-4 sm:p-6"
          >
            <p className="text-sm text-muted-foreground">
              {t("plugins.sourceHelp")}
            </p>
            {sources.keys.length ? (
              <ul className="divide-y divide-border border-b border-border">
                {sources.keys.map((key) => (
                  <li
                    key={sourceIdentity(key)}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <p className="min-w-0 wrap-anywhere text-sm font-medium">
                      {sourceLabel(key, sources.keys)}
                    </p>
                    {key.approved ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked}
                        onClick={() =>
                          setConfirmation({
                            label: "plugins.revokeSource",
                            description: "plugins.revokeSourceDescription",
                            identity: sourceLabel(key, sources.keys),
                            intent: {
                              kind: "revokeSource",
                              expectedRevision: sources.revision,
                              params: {
                                source: key.source,
                                keyId: key.keyId,
                                publicKeySha256: key.publicKeySha256,
                              },
                            },
                          })
                        }
                      >
                        {t("plugins.revokeSource")}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("plugins.revoked")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            <SourceForm
              key={sourceFormEpoch}
              revision={sources.revision}
              blocked={blocked}
              confirm={setConfirmation}
            />
          </section>
        </div>
      ) : null}

      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        {confirmation ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t(confirmation.label)}</DialogTitle>
              <div className="space-y-1">
                <p className="wrap-anywhere text-sm font-medium">
                  {confirmation.identity}
                </p>
                {confirmation.source ? (
                  <p className="wrap-anywhere text-xs text-muted-foreground">
                    {confirmation.source}
                  </p>
                ) : null}
              </div>
              <DialogDescription>
                {t(confirmation.description)}
              </DialogDescription>
            </DialogHeader>
            {confirmation.permissions?.length ? (
              <div className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
                <p className="font-medium">{t("plugins.permissions")}</p>
                <ul className="list-disc space-y-1 ps-4 text-muted-foreground">
                  {confirmation.permissions.map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmation(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant={
                  confirmation.intent.kind === "uninstall"
                    ? "destructive"
                    : "default"
                }
                disabled={blocked}
                onClick={() => {
                  const intent = confirmation.intent;
                  setConfirmation(null);
                  void run(async () => intent);
                }}
              >
                {t(confirmation.label)}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
