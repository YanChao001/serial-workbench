import { memo, type ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  const heading = "h-auto px-2 py-1 text-start";
  const cell = "px-2 py-1 align-top";
  return (
    <Table
      containerProps={{
        role: "region",
        "aria-label": caption,
        tabIndex: 0,
        className:
          "max-h-72 overflow-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring",
      }}
      className="border-collapse text-start"
    >
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader className="sticky top-0 bg-card text-muted-foreground">
        <TableRow>
          <TableHead scope="col" className={heading}>
            {nameLabel ?? t("workbench.fields.name")}
          </TableHead>
          <TableHead scope="col" className={heading}>
            {t("workbench.fields.value")}
          </TableHead>
          <TableHead scope="col" className={heading}>
            {t("workbench.fieldTable.unit")}
          </TableHead>
          <TableHead scope="col" className={heading}>
            {t("workbench.fieldTable.quality")}
          </TableHead>
          {detailsLabel !== undefined && (
            <TableHead scope="col" className={heading}>
              {detailsLabel}
            </TableHead>
          )}
          {actions && (
            <TableHead scope="col" className={heading}>
              {t("workbench.fieldTable.actions")}
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableHead
              scope="row"
              className={
                cell + " h-auto whitespace-normal wrap-anywhere text-start"
              }
            >
              {row.name}
            </TableHead>
            <TableCell
              className={
                cell + " whitespace-normal wrap-anywhere font-mono tabular-nums"
              }
            >
              {row.value}
            </TableCell>
            <TableCell className={cell}>{row.unit ?? "—"}</TableCell>
            <TableCell className={cell + " whitespace-normal"}>
              {row.quality}
            </TableCell>
            {detailsLabel !== undefined && (
              <TableCell className={cell + " font-mono"}>
                {row.details}
              </TableCell>
            )}
            {actions && <TableCell className={cell}>{row.action}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
});
