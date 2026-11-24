import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OptionsSelect } from "@/components/options-select";
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
    <div className="relative overflow-hidden rounded-md border">
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
      className="grid content-start gap-2"
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
        <table className="w-full text-start tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="text-start">
                {t("plugins.spectrum.binRange")}
              </th>
              <th scope="col" className="text-end">
                {t("plugins.spectrum.count")}
              </th>
            </tr>
          </thead>
          <tbody>
            {histogram.bins.map(({ from, to, count }) => (
              <tr key={from} className="border-t">
                <th scope="row" className="py-1 text-start font-normal">
                  {number.format(from)}–{number.format(to)}
                  <div aria-hidden="true" className="h-1.5 max-w-60 bg-muted">
                    <div
                      className="h-full bg-primary"
                      style={{ width: (100 * count) / largest + "%" }}
                    />
                  </div>
                </th>
                <td className="text-end">{number.format(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
      aria-label={t("plugins.spectrum.result")}
      className="grid gap-3 border-t pt-3"
    >
      <p role="status">
        {t("plugins.spectrum.sampleFacts", {
          rate: number.format(report.sampleRateHz),
          period: report.periodNs,
          clock: report.clockId,
          observed: report.observed,
          total: report.expected,
          tail: report.tail,
        })}
      </p>
      <p>
        {t("plugins.spectrum.settings", {
          shape: t(`plugins.spectrum.shape.${report.window.shape}`),
          size: report.window.size,
          hop: report.window.hop,
          detrend: t(`plugins.spectrum.detrend.${report.window.detrend}`),
          missing: t(`plugins.spectrum.missing.${report.window.missing}`),
        })}
      </p>
      <div className="grid gap-5 p-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section
          aria-label={t("plugins.spectrum.waterfall")}
          className="grid min-w-0 content-start gap-3"
        >
          <h4 className="font-medium">{t("plugins.spectrum.waterfall")}</h4>
          {row ? (
            <>
              <Waterfall
                report={report}
                selected={selected}
                minimum={range.minimum}
                select={select}
              />
              <p className="flex flex-wrap justify-between gap-2 text-muted-foreground">
                <span>0–{number.format(report.frequenciesHz.at(-1)!)} Hz</span>
                <span>
                  {t("plugins.spectrum.displayRange", {
                    min: db.format(range.minimum),
                    max: db.format(range.maximum),
                    unit: report.unit ?? t("plugins.spectrum.inputUnit"),
                  })}
                </span>
              </p>
              <label htmlFor={id + "-window"}>
                {t("plugins.spectrum.selectWindow")}
              </label>
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
              <p aria-live="polite" className="text-muted-foreground">
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
                  <label htmlFor={id + "-bin"}>
                    {t("plugins.spectrum.selectBin")}
                  </label>
                  <OptionsSelect
                    id={id + "-bin"}
                    value={String(bin ?? "none")}
                    onValueChange={(value) =>
                      setCheckedBin(
                        value === "none" ? undefined : Number(value),
                      )
                    }
                    options={[
                      { value: "none", label: t("plugins.spectrum.noBin") },
                      ...report.frequenciesHz.map((hz, i) => ({
                        value: String(i),
                        label: number.format(hz) + " Hz",
                      })),
                    ]}
                  />
                  {frequency !== undefined ? (
                    <p aria-live="polite" className="font-mono">
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
