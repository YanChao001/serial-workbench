import { useId, useState } from "react";
import type {
  CommandGroup,
  CommandSummary,
  NodePackageSummary,
  WorkspaceDocumentResult,
  WorkspaceConfigurationInspection,
  WorkspaceScriptReference,
} from "@serial-workbench/contracts";
import { ContractValidationError } from "@serial-workbench/contracts";
import { Package } from "lucide-react";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  loadInstalledPlugins,
  queryNode,
  readNodeInstallation,
} from "@/features/plugins/node-management";
import { nativeErrorCode } from "@/lib/native-error";
import { saveTextExport } from "@/lib/tauri";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useToolAction } from "./transfer-capture-actions";
import { distinctWorkspaceLabels } from "./workspace-model";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkspaceConfigurationSummary } from "./workspace-configuration-summary";

type CommandChoices = {
  revision: string;
  groups: CommandGroup[];
  next?: string;
};
type GroupChoices = {
  id: string;
  rows: CommandSummary[];
  next?: string;
};

export function WorkspaceConfigurationExport({
  base,
  disabled,
}: {
  base: WorkspaceDocumentResult;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={t("workbench.configuration.export")}
          variant="outline"
          disabled={disabled}
        >
          <Package aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[calc(100dvh-3rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto"
      >
        {open && (
          <ExportForm
            key={`${base.scope.scopeId}:${base.document.revision}`}
            base={base}
            onSaved={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ExportForm({
  base,
  onSaved,
}: {
  base: WorkspaceDocumentResult;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const commandLibrary = host.commandLibrary;
  const workspace = base.scope.target;
  const connection =
    host.connection?.attachment.hostId === workspace.hostId
      ? host.connection
      : undefined;
  const id = useId();
  const action = useToolAction((reason) =>
    nativeErrorCode(reason) === "REVISION_CONFLICT"
      ? t("workbench.configuration.exportConflict")
      : t("workbench.configuration.exportError"),
  );
  const [commands, setCommands] = useState<CommandChoices>();
  const [group, setGroup] = useState<GroupChoices>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [plugins, setPlugins] = useState<{
    revision: string;
    packages: NodePackageSummary[];
  }>();
  const [packageId, setPackageId] = useState("");
  const [scripts, setScripts] = useState<WorkspaceScriptReference[]>([]);
  const [selectedScripts, setSelectedScripts] = useState<
    ReadonlyMap<string, WorkspaceScriptReference> | undefined
  >();

  function loadCommands() {
    if (!commandLibrary) return;
    void action.run(async (signal) => {
      const result = await commandLibrary.open(workspace.id, signal);
      if (result.records.view !== "groups") throw new ContractValidationError();
      signal.throwIfAborted();
      setCommands({
        revision: result.revision,
        groups: result.records.groups,
        next: result.records.nextCursor ?? undefined,
      });
      setGroup(undefined);
      setSelected(new Set());
    });
  }

  function loadMoreGroups() {
    if (!commandLibrary || commands?.next === undefined) return;
    void action.run(async (signal) => {
      const result = await commandLibrary.read(
        workspace.id,
        {
          selection: { view: "groups", after: commands.next },
          revision: commands.revision,
        },
        signal,
      );
      if (result.records.view !== "groups") throw new ContractValidationError();
      signal.throwIfAborted();
      setCommands({
        ...commands,
        groups: [...commands.groups, ...result.records.groups],
        next: result.records.nextCursor ?? undefined,
      });
    });
  }

  function loadGroup(groupId: string, more = false) {
    if (!commandLibrary || !commands) return;
    void action.run(async (signal) => {
      const result = await commandLibrary.read(
        workspace.id,
        {
          selection: {
            view: "commands",
            groupId,
            ...(more ? { after: group?.next } : {}),
          },
          revision: commands.revision,
        },
        signal,
      );
      if (result.records.view !== "commands")
        throw new ContractValidationError();
      signal.throwIfAborted();
      setGroup({
        id: groupId,
        rows: [
          ...(more ? (group?.rows ?? []) : []),
          ...result.records.commands,
        ],
        next: result.records.nextCursor ?? undefined,
      });
    });
  }

  function loadPlugins() {
    if (!connection) return;
    void action.run(async (signal) => {
      const list = await loadInstalledPlugins(connection, signal);
      signal.throwIfAborted();
      setPlugins({
        revision: list.revision,
        packages: list.packages.filter(
          (item) =>
            item.enabled && item.sourceVerified && item.executionApproved,
        ),
      });
      setPackageId("");
      setScripts([]);
      setSelectedScripts(undefined);
    });
  }

  function loadScripts(id: string) {
    const entry = plugins?.packages.find((item) => item.id === id);
    if (!entry || !plugins || !connection) return;
    void action.run(async (signal) => {
      const installation = await readNodeInstallation(
        {
          id,
          expectedRevision: plugins.revision,
          archiveSha256: entry.archiveSha256,
        },
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
      signal.throwIfAborted();
      setPackageId(id);
      setScripts(
        installation.manifest.contributes.actions.map(({ actionId }) => ({
          packageId: installation.manifest.id,
          version: installation.manifest.version,
          archiveSha256: installation.archiveSha256,
          actionId,
        })),
      );
    });
  }

  const params = {
    workspaceRevision: base.document.revision,
    ...(commands && selected.size > 0
      ? { commandIds: [...selected], commandRevision: commands.revision }
      : {}),
    ...(selectedScripts === undefined
      ? {}
      : { scripts: [...selectedScripts.values()] }),
  };
  const selection = JSON.stringify(params);
  const [prepared, setPrepared] = useState<{
    selection: string;
    json: string;
    preview: WorkspaceConfigurationInspection;
  }>();
  const current = prepared?.selection === selection ? prepared : undefined;

  function preview() {
    void action.run(async (signal) => {
      setPrepared(undefined);
      const { json } = await host.exportWorkspaceConfiguration(
        workspace.id,
        params,
        signal,
      );
      const preview = await host.inspectWorkspaceConfiguration(
        workspace.id,
        json,
        signal,
      );
      signal.throwIfAborted();
      if (
        preview.workspaceRevision !== params.workspaceRevision ||
        (preview.commandRevision ?? undefined) !== params.commandRevision
      )
        throw { code: "REVISION_CONFLICT" };
      setPrepared({ selection, json, preview });
    });
  }

  function save() {
    if (!current) return;
    void action.run(async (signal) => {
      const path = await saveTextExport(
        t("workbench.configuration.fileName"),
        current.json,
      );
      if (!signal.aborted && path) onSaved();
    });
  }

  return (
    <section
      aria-labelledby={id}
      className="grid min-w-0 gap-3"
      aria-busy={action.busy}
    >
      <h3 id={id} className="font-medium">
        {t("workbench.configuration.export")}
      </h3>
      <fieldset disabled={action.busy} className="grid min-w-0 gap-2">
        <legend className="sr-only">
          {t("workbench.configuration.quickCommands")}
        </legend>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={loadCommands}
          disabled={!commandLibrary}
        >
          {t(
            commands
              ? "workbench.configuration.refreshCommands"
              : "workbench.configuration.chooseCommands",
          )}
        </Button>
        {commands && (
          <>
            {commands.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("workbench.configuration.noCommands")}
              </p>
            ) : (
              <OptionsSelect
                label={t("workbench.configuration.commandGroup")}
                placeholder={t("workbench.configuration.commandGroup")}
                value={group?.id ?? ""}
                options={distinctWorkspaceLabels(
                  commands.groups.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                )}
                onValueChange={loadGroup}
              />
            )}
            {commands.next && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={loadMoreGroups}
              >
                {t("workbench.configuration.moreGroups")}
              </Button>
            )}
          </>
        )}
        {group && (
          <div className="grid max-h-36 gap-2 overflow-auto px-1 py-1.5">
            {group.rows.map((command) => (
              <label
                key={command.id}
                className="flex min-w-0 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={selected.has(command.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(command.id);
                      else next.delete(command.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 wrap-anywhere">{command.name}</span>
              </label>
            ))}
            {group.rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("workbench.configuration.noCommands")}
              </p>
            )}
            {group.next && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => loadGroup(group.id, true)}
              >
                {t("workbench.configuration.moreCommands")}
              </Button>
            )}
          </div>
        )}
        {selected.size > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("workbench.configuration.includedCommandBodies", {
              count: selected.size,
            })}
          </p>
        )}
      </fieldset>
      <fieldset disabled={action.busy} className="grid min-w-0 gap-2">
        <legend className="sr-only">
          {t("workbench.configuration.scripts")}
        </legend>
        {connection && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={loadPlugins}
          >
            {t("workbench.configuration.chooseScripts")}
          </Button>
        )}
        {plugins &&
          (plugins.packages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("workbench.configuration.noScripts")}
            </p>
          ) : (
            <OptionsSelect
              label={t("workbench.configuration.choosePackage")}
              placeholder={t("workbench.configuration.choosePackage")}
              value={packageId}
              options={distinctWorkspaceLabels(
                plugins.packages.map((item) => ({
                  value: item.id,
                  label: item.displayName ?? item.id,
                })),
              )}
              onValueChange={loadScripts}
            />
          ))}
        {packageId && (
          <div className="grid max-h-36 gap-2 overflow-auto px-1 py-1.5">
            {scripts.map((script) => (
              <label
                key={script.actionId}
                className="flex min-w-0 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={selectedScripts?.has(script.actionId) ?? false}
                  onCheckedChange={(checked) =>
                    setSelectedScripts((current) => {
                      const next = new Map(current);
                      if (checked === true) next.set(script.actionId, script);
                      else next.delete(script.actionId);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 wrap-anywhere">{script.actionId}</span>
              </label>
            ))}
            {scripts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("workbench.configuration.noScripts")}
              </p>
            )}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {selectedScripts === undefined
            ? t("workbench.configuration.keepScripts")
            : t("workbench.configuration.selectedScripts", {
                count: selectedScripts.size,
              })}
        </p>
      </fieldset>
      {action.error && (
        <p role="alert" className="text-sm wrap-anywhere">
          {action.error}
        </p>
      )}
      {current && (
        <WorkspaceConfigurationSummary
          preview={current.preview}
          hostId={workspace.hostId}
          mode="export"
        />
      )}
      <Button
        type="button"
        size="sm"
        disabled={action.busy}
        onClick={current ? save : preview}
      >
        {t(
          current
            ? "workbench.configuration.savePackage"
            : "workbench.configuration.previewPackage",
        )}
      </Button>
    </section>
  );
}
