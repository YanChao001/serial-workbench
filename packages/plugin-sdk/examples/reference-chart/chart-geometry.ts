export const chartCanvas = {
  width: 640,
  height: 360,
  left: 72,
  right: 616,
  top: 42,
  bottom: 310,
};

export function chartGeometry(samples: readonly number[]) {
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const padding = (high - low) * 0.06 || 0.5;
  const min = low - padding;
  const max = high + padding;
  const { left, right, top, bottom } = chartCanvas;
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);
  const coordinates = samples.map((value, index) => ({
    x: left + (index * (right - left)) / Math.max(samples.length - 1, 1),
    y: y(value),
  }));
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = min + (index * (max - min)) / 4;
    return { value, label: String(Number(value.toPrecision(5))), y: y(value) };
  });
  return { coordinates, ticks };
}
