import { useId, useState } from "react";
import { OptionsSelect } from "@/components/options-select";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/providers/i18n";
import { windowMetrics, type WindowsReport } from "./windows-report";

const bounds = (from: bigint, to: bigint) => `[${from}, ${to})`;
const slots = (row: WindowsReport["windows"][number]) =>
  bounds(row.fromPosition, row.toPosition);

export function WindowsResult({ report }: { report: WindowsReport }) {
  const { t, language } = useI18n();
  const id = useId();
  const [selected, setSelected] = useState("0");
  const row = report.windows[Number(selected)]!;
  const percentage = new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const rate = (value: number | null) =>
    value === null ? "—" : percentage.format(value);
  const windowLabel = (entry: typeof row) =>
    entry.time ? bounds(entry.time.from, entry.time.to) + " ns" : slots(entry);
  const basis = t(
    report.kind === "time" ? "plugins.windows.time" : "plugins.windows.count",
  );
  const parameter = (value: bigint) =>
    value.toString() + (report.clock ? " ns" : "");

  return (
    <section
      aria-labelledby={id + "-title"}
      className="grid min-w-0 gap-3 border-t pt-4"
    >
      <h4 id={id + "-title"} className="font-semibold">
        {t("plugins.windows.result")}
      </h4>
      <div
        role="status"
        className="grid gap-1 text-sm wrap-anywhere tabular-nums"
      >
        <p>
          {t("plugins.windows.summary", {
            basis,
            range: bounds(report.firstPosition, report.afterPosition),
            length: parameter(report.length),
            step: parameter(report.step),
          })}
        </p>
        {report.clock && (
          <p className="text-muted-foreground">
            {t("plugins.windows.clock", {
              id: report.clock.id,
              origin: report.clock.origin.toString(),
              period: report.clock.period.toString(),
            })}
          </p>
        )}
        {report.unit && (
          <p className="text-muted-foreground">
            {t("plugins.windows.unit", { unit: report.unit })}
          </p>
        )}
      </div>
      <div className="grid min-w-0 justify-items-start gap-1.5">
        <Label htmlFor={id + "-window"}>{t("plugins.windows.selected")}</Label>
        <OptionsSelect
          id={id + "-window"}
          value={selected}
          className="h-8 max-w-64"
          options={report.windows.map((_, index) => ({
            value: String(index),
            label: t("plugins.windows.windowNumber", { number: index + 1 }),
          }))}
          onValueChange={setSelected}
        />
      </div>
      <div
        role="region"
        aria-label={t("plugins.windows.selected")}
        aria-live="polite"
        className="grid min-w-0 gap-2 text-sm"
      >
        {row.partial && (
          <p className="font-medium">{t("plugins.windows.tail")}</p>
        )}
        <div className="grid min-w-0 gap-3 @min-[42rem]/statistics:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @min-[42rem]/statistics:gap-5">
          <dl className="grid min-w-0 content-start grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-4 gap-y-2 wrap-anywhere">
            <div>
              <dt className="text-muted-foreground">
                {t("plugins.windows.positions")}
              </dt>
              <dd className="font-mono">{slots(row)}</dd>
            </div>
            {row.time && (
              <div>
                <dt className="text-muted-foreground">
                  {t("plugins.windows.bounds")}
                </dt>
                <dd className="font-mono">{windowLabel(row)}</dd>
              </div>
            )}
            <div className="tabular-nums">
              <dt className="text-muted-foreground">
                {t("plugins.windows.valid")}
              </dt>
              <dd>
                {row.validCount} / {row.expectedCount}
              </dd>
            </div>
            <div className="tabular-nums">
              <dt className="text-muted-foreground">
                {t("plugins.windows.missing")}
              </dt>
              <dd>
                {row.missingCount} / {row.expectedCount} ·{" "}
                {rate(row.missingRate)}
              </dd>
            </div>
          </dl>
          <div className="min-w-0 border-t pt-3 @min-[42rem]/statistics:border-s @min-[42rem]/statistics:border-t-0 @min-[42rem]/statistics:ps-4 @min-[42rem]/statistics:pt-0">
            {row.metrics ? (
              <dl className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-x-4 gap-y-2">
                {row.metrics.map(({ key, value }) => (
                  <div
                    key={key}
                    className="grid min-w-0 grid-rows-[1fr_auto] gap-0.5 wrap-anywhere"
                  >
                    <dt className="text-muted-foreground">
                      {t(`workbench.fieldChart.statistics.${key}`)}
                    </dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>
                {t(
                  row.expectedCount
                    ? "plugins.windows.noSamples"
                    : "plugins.windows.noSlots",
                )}
              </p>
            )}
          </div>
        </div>
      </div>
      <details className="min-w-0">
        <summary className="cursor-pointer rounded-sm py-1.5 font-medium">
          {t("plugins.windows.compare")}
        </summary>
        <div
          role="region"
          aria-label={t("plugins.windows.compare")}
          tabIndex={0}
          className="max-h-64 min-w-0 overflow-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring [&_[data-slot=table-container]]:w-max [&_[data-slot=table-container]]:min-w-full [&_[data-slot=table-container]]:overflow-visible"
        >
          <Table
            aria-label={t("plugins.windows.compare")}
            className="tabular-nums"
          >
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead scope="col">{t("plugins.windows.window")}</TableHead>
                <TableHead scope="col" className="text-end">
                  {t("plugins.windows.valid")}
                </TableHead>
                <TableHead scope="col" className="text-end">
                  {t("plugins.windows.missing")}
                </TableHead>
                <TableHead scope="col" className="text-end">
                  {t("plugins.windows.rate")}
                </TableHead>
                {windowMetrics.map((key) => (
                  <TableHead key={key} scope="col" className="text-end">
                    {t(`workbench.fieldChart.statistics.${key}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.windows.map((entry, index) => (
                <TableRow key={index}>
                  <TableHead
                    scope="row"
                    className="h-auto py-1.5 wrap-anywhere whitespace-normal font-normal"
                  >
                    {windowLabel(entry)}
                    {entry.partial && (
                      <span className="block text-xs text-muted-foreground">
                        {t("plugins.windows.tail")}
                      </span>
                    )}
                  </TableHead>
                  <TableCell className="text-end">
                    {entry.validCount} / {entry.expectedCount}
                  </TableCell>
                  <TableCell className="text-end">
                    {entry.missingCount} / {entry.expectedCount}
                  </TableCell>
                  <TableCell className="text-end">
                    {rate(entry.missingRate)}
                  </TableCell>
                  {windowMetrics.map((key, index) => (
                    <TableCell key={key} className="text-end">
                      {entry.metrics?.[index]?.value ?? "—"}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </section>
  );
}
