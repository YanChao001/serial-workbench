import { useI18n } from "@/providers/i18n";
import { fieldChartPairs, type FieldChartFrame } from "./field-chart-model";

const left = 24;
const right = 620;
const top = 16;
const bottom = 150;

function axis(values: number[], first: number, last: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const start = min / scale;
  const span = max / scale - start;
  return {
    min,
    max,
    position: (value: number) =>
      span === 0
        ? (first + last) / 2
        : first + ((value / scale - start) / span) * (last - first),
  };
}

export function FieldXyPlot({
  entries,
  start,
  selected,
  xField,
  yField,
  connect,
  onSelect,
}: {
  entries: readonly FieldChartFrame[];
  start: number;
  selected: number;
  xField: string;
  yField: string;
  connect: boolean;
  onSelect: (frameIndex: number) => void;
}) {
  const { t, language } = useI18n();
  const segments = fieldChartPairs(entries, start, xField, yField);
  const points = segments.flat();
  if (!points.length) return <p>{t("workbench.fieldChart.noPairs")}</p>;
  const x = axis(
    points.map((point) => point.x),
    left,
    right,
  );
  const y = axis(
    points.map((point) => point.y),
    bottom,
    top,
  );
  const positioned = segments.map((segment) =>
    segment.map((point) => ({
      index: point.index,
      x: x.position(point.x),
      y: y.position(point.y),
    })),
  );
  const plotPoints = positioned.flat();
  const active = plotPoints.find((point) => point.index === selected);
  const number = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 6,
  });
  const extent = (min: number, max: number) =>
    `${number.format(min)} – ${number.format(max)}`;

  return (
    <>
      <svg
        role="img"
        aria-label={t(
          connect
            ? "workbench.fieldChart.xyLabel"
            : "workbench.fieldChart.scatterLabel",
          { x: xField, y: yField },
        )}
        viewBox="0 0 640 166"
        data-surface="artwork"
        className="w-full rounded border text-primary"
        onPointerDown={(event) => {
          const transform = event.currentTarget.getScreenCTM();
          if (!transform) return;
          const location = new DOMPoint(
            event.clientX,
            event.clientY,
          ).matrixTransform(transform.inverse());
          const distance = (point: (typeof plotPoints)[number]) =>
            (point.x - location.x) ** 2 + (point.y - location.y) ** 2;
          const nearest = plotPoints.reduce(
            (closest, point) =>
              distance(point) < distance(closest) ? point : closest,
            active ?? plotPoints[0]!,
          );
          onSelect(nearest.index);
        }}
      >
        <path
          d={`M ${left} ${top} V ${bottom} H ${right}`}
          fill="none"
          stroke="currentColor"
          opacity="0.45"
        />
        {connect
          ? positioned
              .filter((segment) => segment.length > 1)
              .map((segment) => (
                <polyline
                  key={segment[0]!.index}
                  points={segment
                    .map((point) => `${point.x},${point.y}`)
                    .join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              ))
          : null}
        {plotPoints.map((point) => (
          <circle
            key={point.index}
            cx={point.x}
            cy={point.y}
            r={point === active ? "6" : "3"}
            fill="currentColor"
          />
        ))}
      </svg>
      <p className="wrap-anywhere text-muted-foreground">
        {t("workbench.fieldChart.pairExtents", {
          x: extent(x.min, x.max),
          y: extent(y.min, y.max),
          count: points.length,
        })}
      </p>
    </>
  );
}
