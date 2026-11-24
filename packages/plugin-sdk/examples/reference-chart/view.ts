/// <reference lib="dom" />
import { connectDerivedView } from "@serial-workbench/plugin-sdk/web";
import type { ViewLocale } from "@serial-workbench/plugin-sdk/web";
import { sampleStatistics } from "./sample-statistics";

const status = document.querySelector<HTMLElement>("#status");
const values = document.querySelector<HTMLTableSectionElement>("#values");
const statistics = document.querySelector<HTMLDListElement>("#statistics");
const plot = document.querySelector<HTMLCanvasElement>("#plot");
const paint = plot?.getContext("2d");
if (!status || !values || !statistics || !plot || !paint)
  throw new Error("Chart layout is missing");

const samples: { position: string; voltage: number }[] = [];
let firstPosition = 1n;
let lastPosition = 0n;
let lost = false;
let locale: ViewLocale = "en";
let state: "waiting" | "reading" | "stopped" = "waiting";
let number = new Intl.NumberFormat("en", { maximumFractionDigits: 5 });

function draw(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const { width, height } = canvas.getBoundingClientRect();
  const scale = devicePixelRatio || 1;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  context.scale(scale, scale);
  if (!samples.length || width < 120 || height < 100) return;
  const style = getComputedStyle(canvas);
  const left = 56,
    right = width - 16,
    top = 18,
    bottom = height - 31;
  const numbers = samples.map((sample) => sample.voltage);
  const low = Math.min(...numbers),
    high = Math.max(...numbers);
  const padding = (high - low) * 0.06 || 0.5;
  const min = low - padding,
    max = high + padding;
  const first = firstPosition;
  const last = lastPosition;
  const span = Number(last - first) || 1;
  const x = (position: string) =>
    left + (Number(BigInt(position) - first) / span) * (right - left);
  const y = (value: number) =>
    bottom - ((value - min) / (max - min)) * (bottom - top);

  context.font = "12px system-ui";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillStyle = style.getPropertyValue("--muted");
  context.strokeStyle = style.getPropertyValue("--grid");
  for (let tick = 0; tick <= 4; tick++) {
    const value = min + ((max - min) * tick) / 4;
    const line = y(value);
    context.beginPath();
    context.moveTo(left, line);
    context.lineTo(right, line);
    context.stroke();
    context.fillText(number.format(value), left - 8, line);
  }
  context.textAlign = "left";
  context.fillText(String(first), left, bottom + 17);
  if (last !== first) {
    context.textAlign = "right";
    context.fillText(String(last), right, bottom + 17);
  }
  context.strokeStyle = style.getPropertyValue("--trace");
  context.fillStyle = context.strokeStyle;
  context.lineWidth = 2;
  context.beginPath();
  let previous: bigint | undefined;
  for (const sample of samples) {
    const position = BigInt(sample.position);
    const coordinates = [x(sample.position), y(sample.voltage)] as const;
    if (previous === undefined || position !== previous + 1n)
      context.moveTo(...coordinates);
    else context.lineTo(...coordinates);
    previous = position;
  }
  context.stroke();
  for (const sample of samples) {
    context.beginPath();
    context.arc(x(sample.position), y(sample.voltage), 2.5, 0, Math.PI * 2);
    context.fill();
  }
}

const render = () => draw(plot, paint);
function renderStatus() {
  if (!status) return;
  const zh = locale === "zh-CN";
  if (state === "stopped") {
    status.textContent = zh ? "图表读取已停止" : "Chart reading stopped";
  } else if (state === "waiting") {
    status.textContent = zh ? "正在等待样本…" : "Waiting for samples…";
  } else {
    status.textContent = zh
      ? `${samples.length} 个样本${lost ? " · 早期数据已过期" : ""}`
      : `${samples.length} samples${lost ? " · Earlier data expired" : ""}`;
  }
}

function renderStatistics() {
  if (!statistics) return;
  const zh = locale === "zh-CN";
  const summary = sampleStatistics(
    samples.map(({ voltage }) => voltage),
    lastPosition - firstPosition + 1n,
  );
  const metrics = summary.metrics;
  const detail = new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 });
  const percentage = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const format = (value: number | undefined) =>
    value === undefined ? "—" : `${detail.format(value)} V`;
  const missing = `${summary.missingCount.toLocaleString(locale)} / ${summary.expectedCount.toLocaleString(locale)}`;
  const entries: [string, string][] = [
    [zh ? "最小值" : "Minimum", format(metrics?.minimum)],
    [zh ? "最大值" : "Maximum", format(metrics?.maximum)],
    [zh ? "均值" : "Mean", format(metrics?.average)],
    [
      zh ? "总体标准差" : "Population standard deviation",
      format(metrics?.deviation),
    ],
    ["P50", format(metrics?.p50)],
    ["P95", format(metrics?.p95)],
    ["P99", format(metrics?.p99)],
    [zh ? "有效点" : "Valid points", detail.format(summary.validCount)],
    [
      zh ? "缺点" : "Missing points",
      summary.missingRate === undefined
        ? missing
        : `${missing} (${percentage.format(summary.missingRate)})`,
    ],
  ];
  statistics.replaceChildren(
    ...entries.map(([label, text]) => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = label;
      value.textContent = text;
      group.append(term, value);
      return group;
    }),
  );
}

function renderLocale(next: ViewLocale) {
  locale = next;
  const zh = locale === "zh-CN";
  number = new Intl.NumberFormat(locale, { maximumFractionDigits: 5 });
  document.documentElement.lang = locale;
  document.title = zh ? "电压曲线" : "Voltage trace";
  const labels = {
    heading: document.title,
    samples: zh ? "样本值" : "Sample values",
    position: zh ? "序号" : "Position",
    voltage: zh ? "电压（V）" : "Voltage (V)",
    "statistics-label": zh ? "统计" : "Statistics",
    "statistics-scope": zh
      ? "按当前图表的派生样本序号计数，包括过期序号和无效样本。发布前的丢失没有派生序号。"
      : "Counts positions in the current derived sample range, including expired positions and invalid samples. Loss before publication has no derived position.",
  };
  for (const [id, label] of Object.entries(labels)) {
    const element = document.getElementById(id);
    if (element) element.textContent = label;
  }
  plot?.setAttribute(
    "aria-label",
    zh ? "按序号显示电压" : "Voltage by sample position",
  );
  samples.forEach((sample, index) => {
    const cell = values?.rows[index]?.cells[1];
    if (cell) cell.textContent = number.format(sample.voltage);
  });
  renderStatus();
  renderStatistics();
  render();
}

const observer = new ResizeObserver(render);
observer.observe(plot);
window.addEventListener("pagehide", () => observer.disconnect(), {
  once: true,
});
const view = connectDerivedView({
  onSession() {},
  onLocale: renderLocale,
  onPage(page, gap) {
    lost ||= gap !== undefined;
    lastPosition = BigInt(page.nextPosition);
    for (const sample of page.samples) {
      if (
        typeof sample.value !== "number" ||
        !Number.isFinite(sample.value) ||
        sample.provenance.unit !== "V"
      )
        continue;
      samples.push({ position: sample.position, voltage: sample.value });
      const row = values.insertRow();
      row.insertCell().textContent = sample.position;
      row.insertCell().textContent = number.format(sample.value);
    }
    while (samples.length > 128) {
      values.deleteRow(0);
      samples.shift();
      firstPosition = BigInt(samples[0]!.position);
    }
    state = "reading";
    renderStatus();
    renderStatistics();
    render();
  },
  onError() {
    state = "stopped";
    renderStatus();
  },
});
document.documentElement.dataset.theme = view.dark ? "dark" : "light";
renderLocale(view.locale);
