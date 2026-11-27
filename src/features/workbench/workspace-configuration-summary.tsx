import { useId } from "react";
import type { WorkspaceConfigurationInspection } from "@serial-workbench/contracts";
import { useI18n } from "@/providers/i18n";

export function WorkspaceConfigurationSummary({
  hostId,
  mode = "import",
  preview,
  targetName,
}: {
  hostId: string;
  mode?: "import" | "export";
  preview: WorkspaceConfigurationInspection;
  targetName?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const { workspace, groups, commands, scripts, credentialRefs } =
    preview.configuration;
  const bindings = new Map(
    workspace.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const workspaceName =
    (mode === "import" ? targetName : workspace.name) ||
    t("workbench.configuration.unnamedWorkspace");
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-2 text-sm">
      <h3 id={id} className="font-medium">
        {t("workbench.configuration.importContents")}
      </h3>
      <p className="min-w-0 wrap-anywhere">
        {t(
          mode === "import"
            ? "workbench.configuration.destination"
            : "workbench.configuration.source",
          { name: workspaceName },
        )}
      </p>
      <p className="text-muted-foreground">
        {t("workbench.configuration.workspaceRevision", {
          revision: preview.workspaceRevision,
        })}
        {preview.commandRevision != null && (
          <>
            {" "}
            ·{" "}
            {t("workbench.configuration.commandRevision", {
              revision: preview.commandRevision,
            })}
          </>
        )}
      </p>
      {mode === "export" && (
        <>
          <p>
            {t("workbench.configuration.layout", {
              sidebar: workspace.layout.sidebarWidth,
              panel: workspace.layout.panelHeight,
            })}
          </p>
          {workspace.views.length > 0 && (
            <ul className="grid max-h-32 gap-1 overflow-auto">
              {workspace.views.map((view) => (
                <li key={view.id} className="min-w-0 wrap-anywhere">
                  {t("workbench.configuration.viewSummary", {
                    name: view.name,
                    baud:
                      bindings.get(view.bindingId)?.configuration.baudRate ??
                      "—",
                    receive: view.receiveMode,
                    send: view.sendMode,
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {groups.length > 0 && (
        <div className="grid min-w-0 gap-1">
          <h4 className="font-medium">
            {t(
              mode === "import"
                ? "workbench.configuration.commandCount"
                : "workbench.configuration.includedCommandBodies",
              {
                count: commands.length,
              },
            )}
          </h4>
          <ul className="grid max-h-32 gap-1 overflow-auto">
            {commands.length > 0
              ? commands.map(({ summary }) => (
                  <li key={summary.id} className="min-w-0 wrap-anywhere">
                    {summary.name}
                  </li>
                ))
              : groups.map((group) => (
                  <li key={group.id} className="min-w-0 wrap-anywhere">
                    {group.name}
                  </li>
                ))}
          </ul>
        </div>
      )}
      {scripts.length > 0 && (
        <div className="grid min-w-0 gap-1">
          <h4 className="font-medium">
            {t("workbench.configuration.scripts")}
          </h4>
          <ul className="grid gap-1">
            {scripts.map((script, index) => (
              <li
                key={`${script.packageId}/${script.actionId}`}
                className="min-w-0 wrap-anywhere"
              >
                <span>
                  {script.actionId} {script.version}
                </span>
                <p className="text-muted-foreground">
                  {t(
                    `workbench.configuration.script.${preview.scriptStatuses[index] ?? "unavailable"}`,
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {credentialRefs.length > 0 && (
        <div className="grid min-w-0 gap-1">
          <h4 className="font-medium">
            {t("workbench.configuration.credentials")}
          </h4>
          <ul className="grid gap-1">
            {credentialRefs.map((credential) => (
              <li key={credential.slot} className="min-w-0 wrap-anywhere">
                <span>{credential.slot}</span>
                <p className="text-muted-foreground">
                  {t(
                    credential.hostId === hostId
                      ? "workbench.configuration.credential.local"
                      : "workbench.configuration.credential.remote",
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
