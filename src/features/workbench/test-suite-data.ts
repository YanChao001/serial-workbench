import { formatHex, parseHex } from "@serial-workbench/host-client";
import { isRecord } from "@/lib/settings-model";
import { commandVariablePattern } from "../../../packages/plugin-sdk/src/command-template";
import {
  commandSequenceFrameBytes,
  CommandSequenceError,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";

export type TestInputRow = { kind: "csv" | "table"; row: number };
type Cell = string | number;
type Row = { row: number; cells: readonly Cell[] };
const types = ["hex", "u8", "utf8", "text"] as const;
type BindingType = (typeof types)[number];

function fail(path: string, message: string): never {
  throw new CommandSequenceError(path, message);
}

function csvRecords(source: string, path: string, maxRows: number) {
  const text = source.startsWith("\ufeff") ? source.slice(1) : source;
  let offset = 0;
  let line = 1;
  const records: { row: number; cells: string[] }[] = [];
  const isNewline = (character: string | undefined) =>
    character === "\r" || character === "\n";
  function advanceNewline() {
    offset += text[offset] === "\r" && text[offset + 1] === "\n" ? 2 : 1;
    line++;
  }
  function quoted(rowPath: string) {
    offset++;
    let field = "";
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        if (text[offset] !== '"') return field;
        offset++;
      } else if (character === "\r" && text[offset] === "\n") {
        field += "\r";
        offset++;
        line++;
        field += "\n";
        continue;
      } else if (isNewline(character)) {
        line++;
      }
      field += character;
    }
    fail(rowPath, "Unclosed quoted CSV field");
  }
  function field(rowPath: string) {
    if (text[offset] === '"') return quoted(rowPath);
    const start = offset;
    while (
      offset < text.length &&
      text[offset] !== "," &&
      !isNewline(text[offset])
    ) {
      if (text[offset] === '"') fail(rowPath, "Unexpected quote in CSV field");
      offset++;
    }
    return text.slice(start, offset);
  }
  while (offset < text.length) {
    const row = line;
    const rowPath = path + "[" + row + "]";
    if (records.length >= maxRows + 1) fail(rowPath, "Too many test rounds");
    const cells: string[] = [];
    for (;;) {
      cells.push(field(rowPath));
      const next = text[offset];
      if (next === ",") {
        offset++;
        continue;
      }
      if (isNewline(next)) advanceNewline();
      else if (next !== undefined)
        fail(rowPath, "Expected a CSV separator after the closing quote");
      break;
    }
    records.push({ row, cells });
  }
  return records;
}

function tableRows(value: unknown, path: string, maxRows: number) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "columns" && key !== "rows") ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.rows) ||
    value.rows.length > maxRows
  )
    fail(path, "Expected columns and a bounded table of input rows");

  const rows: Row[] = value.rows.map((cells: unknown, index) => {
    if (
      !Array.isArray(cells) ||
      cells.some(
        (cell: unknown) =>
          typeof cell !== "string" &&
          (typeof cell !== "number" || !Number.isSafeInteger(cell)),
      )
    )
      fail(path + "[" + (index + 1) + "]", "Use text or integer cells");
    return { row: index + 1, cells };
  });
  return { header: value.columns as unknown[], rows };
}

function inputColumns(header: readonly unknown[], path: string) {
  const columns = new Map<string, number>();
  for (const [index, column] of header.entries()) {
    if (
      typeof column !== "string" ||
      !column ||
      column.trim() !== column ||
      columns.has(column)
    )
      fail(path, "Column names must be non-empty and unique");
    columns.set(column, index);
  }
  return columns;
}

function encodeCell(cell: Cell, type: BindingType, path: string) {
  if (type === "u8") {
    const number =
      typeof cell === "number"
        ? cell
        : /^\d{1,3}$/.test(cell)
          ? Number(cell)
          : -1;
    if (!Number.isInteger(number) || number < 0 || number > 255)
      fail(path, "Expected an unsigned decimal byte");
    return formatHex(Uint8Array.of(number));
  }
  if (typeof cell !== "string") fail(path, "Expected a text cell");
  if (type === "text") return cell;

  let bytes: Uint8Array;
  try {
    bytes = type === "hex" ? parseHex(cell) : new TextEncoder().encode(cell);
  } catch {
    fail(path, "Expected complete HEX bytes");
  }
  if (bytes.length > commandSequenceFrameBytes)
    fail(path, "Mapped bytes exceed the frame limit");
  return formatHex(bytes);
}

export function compileTestRows(value: unknown, path: string, maxRows: number) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["csv", "table", "bindings"].includes(key),
    ) ||
    Object.hasOwn(value, "csv") === Object.hasOwn(value, "table") ||
    !isRecord(value.bindings) ||
    Object.keys(value.bindings).length === 0
  )
    fail(path, "Choose one input and map at least one variable");
  const kind = Object.hasOwn(value, "csv") ? "csv" : "table";
  const inputPath = path + "." + kind;
  let header: readonly unknown[];
  let rows: readonly Row[];
  if (kind === "csv") {
    if (typeof value.csv !== "string")
      fail(inputPath, "Expected UTF-8 CSV text");
    const [first, ...data] = csvRecords(value.csv, inputPath, maxRows);
    header = first?.cells ?? [];
    rows = data;
  } else {
    ({ header, rows } = tableRows(value.table, inputPath, maxRows));
  }
  if (!header.length || !rows.length)
    fail(inputPath, "Provide a header and at least one input row");

  const columns = inputColumns(header, inputPath);
  const mappings = Object.entries(value.bindings).map(([variable, binding]) => {
    const bindingPath = path + ".bindings." + variable;
    if (
      !commandVariablePattern.test(variable) ||
      !isRecord(binding) ||
      Object.keys(binding).some((key) => key !== "column" && key !== "type") ||
      typeof binding.column !== "string"
    )
      fail(bindingPath, "Expected a named column and a conversion type");
    const index = columns.get(binding.column);
    const type = types.find((type) => type === binding.type);
    if (index === undefined || !type)
      fail(bindingPath, "Unknown column or conversion type");
    return { variable, index, type };
  });
  return rows.map(({ row, cells }) => {
    const rowPath = inputPath + "[" + row + "]";
    if (cells.length !== header.length)
      fail(rowPath, "The row has a different number of columns");
    const variables = Object.fromEntries(
      mappings.map(({ variable, index, type }) => [
        variable,
        encodeCell(cells[index]!, type, rowPath + "." + variable),
      ]),
    );
    return { source: { kind, row } satisfies TestInputRow, variables };
  });
}
