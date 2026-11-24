export type CalibrationPoint = { raw: bigint; value: bigint };
export type CalibrationTable = {
  points: readonly CalibrationPoint[];
  interpolation: "exact" | "linear";
};

export function absolute(value: bigint) {
  return value < 0n ? -value : value;
}

function roundRatio(numerator: bigint, denominator: bigint) {
  const magnitude = absolute(numerator);
  const divisor = absolute(denominator);
  const rounded = (magnitude + divisor / 2n) / divisor;
  return numerator < 0n === denominator < 0n ? rounded : -rounded;
}

export function calibrate(table: CalibrationTable, raw: bigint) {
  const upper = table.points.findIndex((point) => point.raw >= raw);
  const right = table.points[upper];
  if (!right) return undefined;
  if (right.raw === raw) return right.value;
  const left = table.points[upper - 1];
  if (!left || table.interpolation === "exact") return undefined;
  return (
    left.value +
    roundRatio(
      (raw - left.raw) * (right.value - left.value),
      right.raw - left.raw,
    )
  );
}

export function uncalibrate(table: CalibrationTable, value: bigint) {
  if (table.interpolation === "exact")
    return table.points.find((point) => point.value === value)?.raw;
  const increasing = table.points[0]!.value < table.points[1]!.value;
  const upper = table.points.findIndex((point) =>
    increasing ? point.value >= value : point.value <= value,
  );
  const right = table.points[upper];
  if (!right) return undefined;
  if (right.value === value) return right.raw;
  const left = table.points[upper - 1];
  if (!left) return undefined;
  const raw =
    left.raw +
    roundRatio(
      (value - left.value) * (right.raw - left.raw),
      right.value - left.value,
    );
  return calibrate(table, raw) === value ? raw : undefined;
}
