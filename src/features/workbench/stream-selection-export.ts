import { formatHex } from "@serial-workbench/host-client";
import type { StreamCopySample } from "./stream-copy";

const bytesPerRow = 16;
const bytesPerPage = bytesPerRow * 64;

export type StreamExportFormat = "html" | "svg";
export type StreamExportTheme = "light" | "dark";

export const streamExportColors = {
  light: { background: "#ffffff", foreground: "#18181b", muted: "#52525b" },
  dark: { background: "#18181b", foreground: "#f4f4f5", muted: "#a1a1aa" },
} satisfies Record<StreamExportTheme, Record<string, string>>;

const escapeMarkup = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const streamExportPageCount = (sample: StreamCopySample) =>
  Math.ceil(sample.bytes.length / bytesPerPage);

type Row = { offset: string; hex: string; ascii: string };

const formatRow = ({ offset, hex, ascii }: Row) =>
  offset.padStart(20) + "  " + hex.padEnd(47) + "  |" + ascii + "|";

export function streamExportPage(sample: StreamCopySample, page: number) {
  const pages = streamExportPageCount(sample);
  if (!Number.isInteger(page) || page < 0 || page >= pages)
    throw new RangeError("Invalid selection page");
  const first = page * bytesPerPage;
  const end = Math.min(first + bytesPerPage, sample.bytes.length);
  const rows: Row[] = [];
  for (let from = first; from < end; from += bytesPerRow) {
    const bytes = sample.bytes.subarray(
      from,
      Math.min(from + bytesPerRow, end),
    );
    const ascii = Array.from(bytes, (byte) =>
      byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".",
    ).join("");
    rows.push({
      offset: (sample.offset + BigInt(from)).toString(),
      hex: formatHex(bytes),
      ascii,
    });
  }
  return {
    rows,
    range: `${page + 1}/${pages} · [${sample.offset + BigInt(first)}, ${sample.offset + BigInt(end)})`,
  };
}

export function formatStreamExport(
  sample: StreamCopySample,
  format: StreamExportFormat,
  theme: StreamExportTheme,
  page: number,
) {
  const { background, foreground, muted } = streamExportColors[theme];
  const length = sample.bytes.length;
  const title = `Serial Workbench · ${sample.direction} · [${sample.offset}, ${sample.offset + BigInt(length)}) · ${length} B`;
  const stem = `serial-selection-${sample.direction.toLowerCase()}-${sample.offset}`;
  if (format === "svg") {
    const { rows, range } = streamExportPage(sample, page);
    const height = 80 + rows.length * 20;
    const lines = rows.map(
      (line, index) =>
        `<text x="16" y="${68 + index * 20}">${escapeMarkup(formatRow(line))}</text>`,
    );
    return {
      name: `${stem}-p${page + 1}.svg`,
      content: [
        `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="${height}" viewBox="0 0 860 ${height}" role="img">`,
        `<title>${escapeMarkup(title)}</title>`,
        `<rect width="100%" height="100%" fill="${background}"/>`,
        `<g xml:space="preserve" font-family="monospace" font-size="14" fill="${foreground}">`,
        `<text x="16" y="24">${escapeMarkup(title)}</text>`,
        `<text x="16" y="44" fill="${muted}">${escapeMarkup(range)}</text>`,
        ...lines,
        "</g></svg>",
      ].join("\n"),
    };
  }

  const sections = Array.from(
    { length: streamExportPageCount(sample) },
    (_, index) => {
      const { rows, range } = streamExportPage(sample, index);
      return `<section><h2>${escapeMarkup(range)}</h2><pre>${escapeMarkup(rows.map(formatRow).join("\n"))}</pre></section>`;
    },
  );
  return {
    name: `${stem}.html`,
    content: [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'\">",
      `<title>${escapeMarkup(title)}</title>`,
      `<style>body{margin:1.25rem;background:${background};color:${foreground};color-scheme:${theme};font:14px/1.5 system-ui}h1{font-size:1.1rem;overflow-wrap:anywhere}h2{font-size:1rem;color:${muted}}pre{overflow:auto;font:13px/1.55 monospace}section+section{border-top:1px solid ${muted}}@media print{section+section{break-before:page}pre{white-space:pre-wrap}}</style>`,
      `</head><body><main><h1>${escapeMarkup(title)}</h1>`,
      ...sections,
      "</main></body></html>",
    ].join("\n"),
  };
}
