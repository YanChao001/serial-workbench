import { useId } from "react";
import type { WorkspaceConfigurationInspection } from "@serial-workbench/contracts";
import { useI18n } from "@/providers/i18n";

export function WorkspaceConfigurationSummary({
  hostId,
  preview,
}: {
  hostId: string;
  preview: WorkspaceConfigurationInspection;
}) {
  const { t } = useI18n();
  const id = useId();
  const { groups, commands, scripts, credentialRefs } = preview.configuration;
  if (!groups.length && !scripts.length && !credentialRefs.length) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-2 text-sm">
      <h3 id={id} className="font-medium">
        {t("workbench.configuration.importContents")}
      </h3>
      {groups.length > 0 && (
        <div className="grid min-w-0 gap-1">
          <h4 className="font-medium">
            {t("workbench.configuration.commandCount", {
              count: commands.length,
            })}
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
