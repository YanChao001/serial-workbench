/// <reference lib="dom" />
import { connectDerivedView } from "@serial-workbench/plugin-sdk/web";

const status = document.querySelector<HTMLElement>("#status");
const values = document.querySelector<HTMLTableSectionElement>("#values");
const plot = document.querySelector<HTMLCanvasElement>("#plot");
const paint = plot?.getContext("2d");
if (!status || !values || !plot || !paint)
  throw new Error("Chart layout is missing");

const samples: { position: string; voltage: number }[] = [];
let lost = false;
let zh = false;
let number = new Intl.NumberFormat("en", { maximumFractionDigits: 5 });

function draw(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const { width, height } = canvas.getBoundingClientRect();
  const scale = devicePixelRatio || 1;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  context.scale(scale, scale);
  const firstSample = samples.at(0),
    lastSample = samples.at(-1);
  if (!firstSample || !lastSample || width < 120 || height < 100) return;
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
  const first = lost ? 1n : BigInt(firstSample.position);
  const last = BigInt(lastSample.position);
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
const observer = new ResizeObserver(render);
observer.observe(plot);
window.addEventListener("pagehide", () => observer.disconnect(), {
  once: true,
});
const view = connectDerivedView({
  onSession() {},
  onPage(page, gap) {
    lost ||= gap !== undefined;
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
    }
    status.textContent = zh
      ? `${samples.length} 个样本${lost ? " · 早期数据已过期" : ""}`
      : `${samples.length} samples${lost ? " · Earlier data expired" : ""}`;
    render();
  },
  onError() {
    status.textContent = zh ? "图表读取已停止" : "Chart reading stopped";
  },
});
zh = view.locale === "zh-CN";
number = new Intl.NumberFormat(view.locale, { maximumFractionDigits: 5 });
document.documentElement.lang = view.locale;
document.documentElement.dataset.theme = view.dark ? "dark" : "light";
if (zh) {
  document.title = "电压曲线";
  const labels = {
    heading: "电压曲线",
    samples: "样本值",
    position: "序号",
    voltage: "电压（V）",
  };
  for (const [id, label] of Object.entries(labels)) {
    const element = document.getElementById(id);
    if (element) element.textContent = label;
  }
  status.textContent = "正在等待样本…";
  plot.setAttribute("aria-label", "按序号显示电压");
}
