import { memo, type ReactNode } from "react";
import { useI18n } from "@/providers/i18n";

export type StructuredFieldRow = {
  id: string;
  name: string;
  value: string;
  unit?: string;
  quality: string;
  details?: string;
  action?: ReactNode;
};

export const StructuredFieldTable = memo(function StructuredFieldTable({
  caption,
  nameLabel,
  detailsLabel,
  actions,
  rows,
}: {
  caption: string;
  nameLabel?: string;
  detailsLabel?: string;
  actions?: boolean;
  rows: readonly StructuredFieldRow[];
}) {
  const { t } = useI18n();
  const heading = "whitespace-nowrap px-2 py-1 text-start font-medium";
  const cell = "px-2 py-1 align-top";
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full border-collapse text-start text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card text-muted-foreground">
          <tr>
            <th scope="col" className={heading}>
              {nameLabel ?? t("workbench.fields.name")}
            </th>
            <th scope="col" className={heading}>
              {t("workbench.fields.value")}
            </th>
            <th scope="col" className={heading}>
              {t("workbench.fieldTable.unit")}
            </th>
            <th scope="col" className={heading}>
              {t("workbench.fieldTable.quality")}
            </th>
            {detailsLabel !== undefined && (
              <th scope="col" className={heading}>
                {detailsLabel}
              </th>
            )}
            {actions && (
              <th scope="col" className={heading}>
                {t("workbench.fieldTable.actions")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <th
                scope="row"
                className={cell + " wrap-anywhere text-start font-medium"}
              >
                {row.name}
              </th>
              <td className={cell + " wrap-anywhere font-mono tabular-nums"}>
                {row.value}
              </td>
              <td className={cell}>{row.unit ?? "—"}</td>
              <td className={cell}>{row.quality}</td>
              {detailsLabel !== undefined && (
                <td className={cell + " whitespace-nowrap font-mono"}>
                  {row.details}
                </td>
              )}
              {actions && <td className={cell}>{row.action}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
