import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import type { SpectrumReport } from "./spectrum-report";

const displaySpanDb = 80;
const noSignal = "#17243b";
const unavailable = "#697487";

function displayRange(windows: SpectrumReport["windows"]) {
  const available = windows.flatMap(
    ({ amplitudeDb }) =>
      amplitudeDb?.filter((v): v is number => v !== null) ?? [],
  );
  const maximum = available.length ? Math.max(...available) : 0;
  return { maximum, minimum: maximum - displaySpanDb };
}

function waterfallColor(level: number | null, minimum: number) {
  if (level === null) return noSignal;
  const fraction = Math.max(0, Math.min(1, (level - minimum) / displaySpanDb));
  return (
    "hsl(" + (218 - fraction * 184) + " 77% " + (17 + fraction * 43) + "%)"
  );
}

function Waterfall({
  report,
  selected,
  minimum,
  select,
}: {
  report: SpectrumReport;
  selected: number;
  minimum: number;
  select: (index: number) => void;
}) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const height = 12;
  const width = report.frequenciesHz.length * 2;
  useEffect(() => {
    const painter = canvas.current?.getContext("2d");
    if (!painter) return;
    report.windows.forEach(({ amplitudeDb }, row) => {
      const y = row * height;
      if (!amplitudeDb) {
        painter.fillStyle = unavailable;
        painter.fillRect(0, y, width, height);
        return;
      }
      amplitudeDb.forEach((db, bin) => {
        painter.fillStyle = waterfallColor(db, minimum);
        painter.fillRect(bin * 2, y, 2, height);
      });
    });
  }, [report, minimum, width]);
  return (
    <div
      data-surface="artwork"
      className="relative min-w-0 overflow-hidden rounded-md border"
    >
      <canvas
        ref={canvas}
        width={width}
        height={report.windows.length * height}
        role="img"
        aria-label={t("plugins.spectrum.waterfallImage")}
        className="block h-36 w-full [image-rendering:pixelated]"
        onPointerDown={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.height <= 0) return;
          const index = Math.floor(
            ((event.clientY - box.top) / box.height) * report.windows.length,
          );
          if (index >= 0 && index < report.windows.length) select(index);
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 border border-white"
        style={{
          top: (selected * 100) / report.windows.length + "%",
          height: 100 / report.windows.length + "%",
        }}
      />
    </div>
  );
}

function SpectrumTrace({
  bins,
  minimum,
}: {
  bins: NonNullable<SpectrumReport["windows"][number]["amplitudeDb"]>;
  minimum: number;
}) {
  const { t } = useI18n();
  const points: { x: number; y: number; command: "M" | "L"; index: number }[] =
    [];
  let previous = false;
  for (const [index, level] of bins.entries()) {
    if (level === null) {
      previous = false;
      continue;
    }
    const x = 12 + (index * 616) / (bins.length - 1);
    const y =
      126 -
      (Math.max(0, Math.min(displaySpanDb, level - minimum)) * 110) /
        displaySpanDb;
    points.push({ x, y, command: previous ? "L" : "M", index });
    previous = true;
  }
  const path = points
    .map(({ x, y, command }) => command + x.toFixed(2) + " " + y.toFixed(2))
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={t("plugins.spectrum.spectrumImage")}
      viewBox="0 0 640 142"
      data-surface="artwork"
      className="w-full rounded-md border bg-background text-primary"
    >
      <path
        d="M12 16H628M12 71H628M12 126H628"
        stroke="currentColor"
        opacity="0.18"
        fill="none"
      />
      <path d={path} stroke="currentColor" strokeWidth="2" fill="none" />
      {points
        .filter(
          (point, i) => point.command === "M" && points[i + 1]?.command !== "L",
        )
        .map((point) => (
          <circle
            key={point.index}
            cx={point.x}
            cy={point.y}
            r="3"
            fill="currentColor"
          />
        ))}
    </svg>
  );
}

function Histogram({ histogram }: { histogram: SpectrumReport["histogram"] }) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 6,
  });
  const largest = Math.max(1, ...histogram.bins.map(({ count }) => count));
  return (
    <section
      className="grid min-w-0 content-start gap-2"
      aria-label={t("plugins.spectrum.histogram")}
    >
      <h4 className="font-medium">{t("plugins.spectrum.histogram")}</h4>
      <p className="text-muted-foreground">
        {t("plugins.spectrum.histogramOutside", {
          below: histogram.below,
          above: histogram.above,
        })}
      </p>
      {histogram.bins.length ? (
        <Table className="tabular-nums">
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="h-8">
                {t("plugins.spectrum.binRange")}
              </TableHead>
              <TableHead scope="col" className="h-8 text-end">
                {t("plugins.spectrum.count")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {histogram.bins.map(({ from, to, count }) => (
              <TableRow key={from}>
                <TableHead
                  scope="row"
                  className="h-auto py-1.5 wrap-anywhere whitespace-normal font-normal"
                >
                  {number.format(from)}–{number.format(to)}
                  <span
                    aria-hidden="true"
                    className="mt-1 block h-1.5 max-w-60 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full bg-primary"
                      style={{ width: (100 * count) / largest + "%" }}
                    />
                  </span>
                </TableHead>
                <TableCell className="text-end">
                  {number.format(count)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p>{t("plugins.spectrum.noValues")}</p>
      )}
    </section>
  );
}

export function SpectrumResult({ report }: { report: SpectrumReport }) {
  const { t, language } = useI18n();
  const id = useId();
  const [selected, setSelected] = useState(0);
  const [checkedBin, setCheckedBin] = useState<number>();
  const row = report.windows[selected];
  const number = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 6,
  });
  const db = new Intl.NumberFormat(language, { maximumFractionDigits: 3 });
  const range = useMemo(() => displayRange(report.windows), [report]);
  const bin = checkedBin ?? row?.peakBin;
  const frequency =
    bin === undefined || bin === null ? undefined : report.frequenciesHz[bin];
  const level =
    bin === undefined || bin === null ? undefined : row?.amplitudeDb?.[bin];
  const select = (index: number) => {
    setSelected(index);
    setCheckedBin(undefined);
  };
  return (
    <section
      aria-labelledby={id + "-title"}
      className="@container/analysis grid min-w-0 gap-3 border-t pt-4"
    >
      <h4 id={id + "-title"} className="font-semibold">
        {t("plugins.spectrum.result")}
      </h4>
      <p role="status" className="wrap-anywhere tabular-nums">
        {t("plugins.spectrum.sampleFacts", {
          rate: number.format(report.sampleRateHz),
          period: report.periodNs,
          clock: report.clockId,
          observed: report.observed,
          total: report.expected,
          tail: report.tail,
        })}
      </p>
      <p className="wrap-anywhere text-muted-foreground">
        {t("plugins.spectrum.settings", {
          shape: t(`plugins.spectrum.shape.${report.window.shape}`),
          size: report.window.size,
          hop: report.window.hop,
          detrend: t(`plugins.spectrum.detrend.${report.window.detrend}`),
          missing: t(`plugins.spectrum.missing.${report.window.missing}`),
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @min-[42rem]/analysis:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section
          aria-label={t("plugins.spectrum.waterfall")}
          className="grid min-w-0 content-start gap-3"
        >
          <h4 className="font-medium">{t("plugins.spectrum.waterfall")}</h4>
          {row ? (
            <>
              <figure className="grid min-w-0 gap-2">
                <Waterfall
                  report={report}
                  selected={selected}
                  minimum={range.minimum}
                  select={select}
                />
                <figcaption className="flex flex-wrap justify-between gap-x-4 gap-y-1 wrap-anywhere text-muted-foreground tabular-nums">
                  <span>
                    0–{number.format(report.frequenciesHz.at(-1)!)} Hz
                  </span>
                  <span>
                    {t("plugins.spectrum.displayRange", {
                      min: db.format(range.minimum),
                      max: db.format(range.maximum),
                      unit: report.unit ?? t("plugins.spectrum.inputUnit"),
                    })}
                  </span>
                </figcaption>
              </figure>
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor={id + "-window"}>
                  {t("plugins.spectrum.selectWindow")}
                </Label>
                <OptionsSelect
                  id={id + "-window"}
                  value={String(selected)}
                  onValueChange={(value) => select(Number(value))}
                  options={report.windows.map(
                    ({ fromOffsetNs, toOffsetNs }, i) => ({
                      value: String(i),
                      label: fromOffsetNs + "–" + toOffsetNs + " ns",
                    }),
                  )}
                />
              </div>
              <p
                aria-live="polite"
                className="wrap-anywhere text-muted-foreground tabular-nums"
              >
                {t("plugins.spectrum.windowStatus", {
                  state: t(`plugins.spectrum.status.${row.status}`),
                  from: row.fromPosition,
                  to: row.toPosition,
                  missing: row.missingCount,
                })}
              </p>
              {row.amplitudeDb ? (
                <SpectrumTrace bins={row.amplitudeDb} minimum={range.minimum} />
              ) : null}
              {row.amplitudeDb ? (
                <>
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor={id + "-bin"}>
                      {t("plugins.spectrum.selectBin")}
                    </Label>
                    <OptionsSelect
                      id={id + "-bin"}
                      value={String(checkedBin ?? "peak")}
                      onValueChange={(value) =>
                        setCheckedBin(
                          value === "peak" ? undefined : Number(value),
                        )
                      }
                      options={[
                        { value: "peak", label: t("plugins.spectrum.noBin") },
                        ...report.frequenciesHz.map((hz, i) => ({
                          value: String(i),
                          label: number.format(hz) + " Hz",
                        })),
                      ]}
                    />
                  </div>
                  {frequency !== undefined ? (
                    <p
                      aria-live="polite"
                      className="wrap-anywhere font-mono tabular-nums"
                    >
                      {number.format(frequency)} Hz ·{" "}
                      {level == null ? "—" : db.format(level) + " dB"}
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <p>{t("plugins.spectrum.noWindows")}</p>
          )}
        </section>
        <Histogram histogram={report.histogram} />
      </div>
    </section>
  );
}
