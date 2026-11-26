import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/providers/i18n";
import type { CapturedXyChannel, CapturedXyPair } from "@/lib/xy-capture";
import type { XyPair, XyReport } from "./xy-analysis-model";

const low = 28;
const high = 342;

function axis(values: number[], start: number, end: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const base = min / scale;
  const span = max / scale - base;
  return {
    min,
    max,
    pixel: (value: number) =>
      span === 0
        ? (start + end) / 2
        : start + ((value / scale - base) / span) * (end - start),
  };
}

function coordinates(pairs: XyReport["pairs"]) {
  const points = pairs.flatMap(({ x, y, breakBefore }) => {
    if (x.value === null || y.status === "missing") return [];
    return [
      {
        index: x.index,
        x: Number(x.value),
        y: Number(y.status === "exact" ? y.sample.value : y.value),
        interpolated: y.status === "interpolated",
        breakBefore,
      },
    ];
  });
  if (!points.length) return undefined;
  const horizontal = axis(
    points.map((point) => point.x),
    low,
    high,
  );
  const vertical = axis(
    points.map((point) => point.y),
    high,
    low,
  );
  const placed = points.map((point) => ({
    ...point,
    x: horizontal.pixel(point.x),
    y: vertical.pixel(point.y),
  }));
  const trace = placed
    .map(({ index, x, y, breakBefore }, i) => {
      const previous = placed[i - 1];
      const command =
        previous && previous.index === index - 1 && !breakBefore ? "L" : "M";
      return command + x.toFixed(2) + " " + y.toFixed(2);
    })
    .join(" ");
  return { points: placed, trace, horizontal, vertical };
}

function Plot({
  report,
  graph,
  selected,
  onSelect,
}: {
  report: XyReport;
  graph: NonNullable<ReturnType<typeof coordinates>>;
  selected: number;
  onSelect(index: number): void;
}) {
  const { t, language } = useI18n();
  const [connect, setConnect] = useState(true);
  const number = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 6,
  });
  const axes = [
    { name: report.x.sourceId, ...graph.horizontal },
    { name: report.y.sourceId, ...graph.vertical },
  ];
  return (
    <figure className="grid min-w-0 gap-2">
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant={connect ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={connect}
          onClick={() => setConnect(true)}
        >
          {t("plugins.xy.trace")}
        </Button>
        <Button
          type="button"
          variant={connect ? "ghost" : "secondary"}
          size="sm"
          aria-pressed={!connect}
          onClick={() => setConnect(false)}
        >
          {t("plugins.xy.scatter")}
        </Button>
      </div>
      <svg
        role="img"
        aria-label={t("workbench.fieldChart.xyLabel", {
          x: report.x.sourceId,
          y: report.y.sourceId,
        })}
        viewBox="0 0 370 370"
        data-surface="artwork"
        className="w-full max-w-96 rounded-md border bg-background text-primary"
        onPointerDown={(event) => {
          const matrix = event.currentTarget.getScreenCTM();
          if (!matrix) return;
          const location = new DOMPoint(
            event.clientX,
            event.clientY,
          ).matrixTransform(matrix.inverse());
          const nearest = graph.points.reduce((closest, point) =>
            Math.hypot(point.x - location.x, point.y - location.y) <
            Math.hypot(closest.x - location.x, closest.y - location.y)
              ? point
              : closest,
          );
          onSelect(nearest.index);
        }}
      >
        <path
          d="M 28 28 H 342 V 342 H 28 Z M 28 106.5 H 342 M 28 185 H 342 M 28 263.5 H 342 M 106.5 28 V 342 M 185 28 V 342 M 263.5 28 V 342"
          fill="none"
          stroke="currentColor"
          opacity="0.18"
        />
        {connect ? (
          <path
            data-xy-trace=""
            d={graph.trace}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        ) : null}
        {graph.points.map(({ index, x, y, interpolated }) => (
          <circle
            key={index}
            cx={x}
            cy={y}
            r={index === selected ? 6 : 3}
            fill={interpolated ? "var(--background)" : "currentColor"}
            stroke="currentColor"
            strokeWidth={index === selected ? 2.5 : 1.4}
          />
        ))}
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-x-4 gap-y-1 wrap-anywhere text-muted-foreground tabular-nums">
        {axes.map(({ name, min, max }, index) => (
          <span key={index}>
            {index === 0 ? "X" : "Y"} {name} ({number.format(min)} –{" "}
            {number.format(max)})
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function Origin({
  point,
  side,
  channel,
}: {
  point: XyPair["x"];
  side: "X" | "Y";
  channel?: CapturedXyChannel;
}) {
  const { t } = useI18n();
  const captured = channel?.samples[point.index];
  const origin =
    captured?.monoNs === point.time && captured.value === point.value
      ? captured.origin
      : undefined;
  return (
    <div className="grid gap-0.5 wrap-anywhere font-mono tabular-nums">
      <p>
        {side} #{point.index + 1} · {point.time} ns ·{" "}
        {point.value ?? t("plugins.xy.missingValue")}
      </p>
      {origin ? (
        <p className="text-xs text-muted-foreground">
          {t("plugins.xy.captureOrigin", {
            frame: origin.frame,
            event: origin.event,
            start: origin.firstByte,
            end: origin.afterByte,
          })}
          {origin.record !== undefined
            ? " · " + t("plugins.xy.captureRecord", { record: origin.record })
            : null}
        </p>
      ) : null}
    </div>
  );
}

function Evidence({
  pair,
  captured,
}: {
  pair: XyPair;
  captured?: CapturedXyPair;
}) {
  const { t } = useI18n();
  const { y } = pair;
  return (
    <div className="grid gap-1" aria-live="polite">
      <p className="font-medium">
        {t(
          y.status === "missing"
            ? `plugins.xy.reason.${y.reason}`
            : `plugins.xy.status.${y.status}`,
        )}
      </p>
      <Origin point={pair.x} side="X" channel={captured?.x} />
      {y.status === "exact" ? (
        <Origin point={y.sample} side="Y" channel={captured?.y} />
      ) : null}
      {y.status !== "exact" && y.before ? (
        <Origin point={y.before} side="Y" channel={captured?.y} />
      ) : null}
      {y.status !== "exact" && y.after ? (
        <Origin point={y.after} side="Y" channel={captured?.y} />
      ) : null}
      {y.status === "interpolated" ? (
        <p className="wrap-anywhere font-mono tabular-nums">
          {t("plugins.xy.weight", {
            value: y.value,
            numerator: y.fraction.numerator,
            denominator: y.fraction.denominator,
          })}
        </p>
      ) : null}
      {pair.breakBefore ? (
        <p className="text-muted-foreground">{t("plugins.xy.break")}</p>
      ) : null}
    </div>
  );
}

export function XyAnalysisResult({
  report,
  captured,
}: {
  report: XyReport;
  captured?: CapturedXyPair;
}) {
  const { t } = useI18n();
  const id = useId();
  const [selected, setSelected] = useState(0);
  const graph = useMemo(() => coordinates(report.pairs), [report]);
  const pair = report.pairs[selected];
  return (
    <section
      aria-labelledby={id + "-results"}
      className="@container/analysis grid min-w-0 gap-3 border-t pt-4"
    >
      <h4 id={id + "-results"} className="font-semibold">
        {t("plugins.xy.result")}
      </h4>
      <p role="status">
        {t("plugins.xy.counts", {
          total: report.pairs.length,
          valid: graph?.points.length ?? 0,
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @min-[42rem]/analysis:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {graph ? (
          <Plot
            report={report}
            graph={graph}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          <p>{t("workbench.fieldChart.noPairs")}</p>
        )}
        <div className="grid min-w-0 content-start gap-3 border-t pt-3 @min-[42rem]/analysis:border-s @min-[42rem]/analysis:border-t-0 @min-[42rem]/analysis:ps-4 @min-[42rem]/analysis:pt-0">
          <dl className="grid min-w-0 gap-2">
            <div>
              <dt className="text-muted-foreground">
                {t("plugins.xy.clocks")}
              </dt>
              <dd className="wrap-anywhere font-mono">
                X {report.x.clockId} / Y {report.y.clockId}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("plugins.xy.rate")}</dt>
              <dd className="wrap-anywhere font-mono tabular-nums">
                {report.clockRate.numerator} / {report.clockRate.denominator}
              </dd>
            </div>
            {report.anchors.length ? (
              <div>
                <dt className="text-muted-foreground">
                  {t("plugins.xy.anchors")}
                </dt>
                {report.anchors.map(({ x, y }) => (
                  <dd key={x} className="wrap-anywhere font-mono">
                    X {x} ns / Y {y} ns
                  </dd>
                ))}
              </div>
            ) : null}
          </dl>
          {captured
            ? (
                [
                  ["X", captured.x],
                  ["Y", captured.y],
                ] as const
              ).map(([axis, channel]) => (
                <p key={axis} className="wrap-anywhere text-muted-foreground">
                  {axis}{" "}
                  {t("plugins.xy.captureClock", {
                    host: channel.host,
                    session: channel.session ?? "—",
                    clock: channel.clock,
                  })}
                </p>
              ))
            : null}
          {pair ? (
            <div className="grid gap-2 border-t pt-3">
              <Label htmlFor={id + "-pair"}>{t("plugins.xy.point")}</Label>
              <Input
                id={id + "-pair"}
                type="number"
                className="w-24"
                min={1}
                max={report.pairs.length}
                value={selected + 1}
                onChange={(event) => {
                  const index = event.currentTarget.valueAsNumber - 1;
                  if (
                    Number.isInteger(index) &&
                    index >= 0 &&
                    index < report.pairs.length
                  )
                    setSelected(index);
                }}
              />
              <Evidence pair={pair} captured={captured} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
