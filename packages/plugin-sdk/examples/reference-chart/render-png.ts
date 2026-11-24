import { crc32, deflateSync } from "node:zlib";
import { chartCanvas, chartGeometry } from "./chart-geometry.ts";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const palette = Buffer.from([
  255, 255, 255, 215, 222, 231, 57, 68, 84, 34, 99, 80,
]);

// 只含坐标刻度和两个英文轴标题使用的 5 × 7 字形。
const glyphs: Readonly<Record<string, readonly number[]>> = {
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
  "-": [0, 0, 0, 14, 0, 0, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  ".": [0, 0, 0, 0, 0, 12, 12],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  A: [14, 17, 17, 31, 17, 17, 17],
  E: [31, 16, 16, 30, 16, 16, 31],
  G: [14, 17, 16, 23, 17, 17, 15],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  V: [17, 17, 17, 17, 17, 10, 4],
};

function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(
    crc32(bytes.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return bytes;
}

export function renderPng(samples: readonly number[]) {
  const { width, height, left, right } = chartCanvas;
  const { ticks, coordinates } = chartGeometry(samples);
  const stride = width + 1;
  // 缓冲区首列保留 PNG 的按行滤波标记 0，其他位置初始为白色索引。
  const raster = Buffer.alloc(stride * height);
  function dot(x: number, y: number, color: number) {
    raster[y * stride + x + 1] = color;
  }
  function text(label: string, x: number, y: number, scale: number) {
    for (const [index, char] of [...label.toUpperCase()].entries()) {
      const rows = glyphs[char];
      if (!rows) continue;
      for (let row = 0; row < 7 * scale; row++) {
        const mask = rows[Math.floor(row / scale)]!;
        for (let column = 0; column < 5 * scale; column++) {
          if (mask & (16 >> Math.floor(column / scale))) {
            dot(x + index * 6 * scale + column, y + row, 2);
          }
        }
      }
    }
  }
  for (const tick of ticks) {
    const row = Math.round(tick.y);
    raster.fill(1, row * stride + left + 1, row * stride + right + 2);
    const label =
      tick.label.length > 10 ? tick.value.toExponential(2) : tick.label;
    const scale = label.length <= 5 ? 2 : 1;
    text(label, left - 8 - label.length * 6 * scale, row - 3 * scale, scale);
  }
  text("VOLTAGE (V)", left, 13, 2);
  text("SAMPLE 1", left, 328, 2);
  if (samples.length > 1) {
    const last = String(samples.length);
    text(last, right - 12 * last.length, 328, 2);
  }
  for (const [index, point] of coordinates.entries()) {
    const previous = coordinates[index - 1];
    if (previous) {
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))),
      );
      for (let step = 0; step <= steps; step++) {
        const x = Math.round(previous.x + (dx * step) / steps);
        const y = Math.round(previous.y + (dy * step) / steps);
        dot(x, y, 3);
        dot(x, y + 1, 3);
      }
    }
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    for (let row = -3; row <= 3; row++) {
      for (let column = -3; column <= 3; column++) {
        if (row * row + column * column <= 9) dot(x + column, y + row, 3);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("sRGB", Buffer.from([0])),
    chunk("PLTE", palette),
    chunk("tEXt", Buffer.from("Title\0Voltage by sample")),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
