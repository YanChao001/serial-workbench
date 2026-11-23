export const HEX_COLUMNS = ["0", "8", "16", "32", "64"] as const;
export const HEX_GROUPS = ["1", "2", "4", "8"] as const;

export type HexFormat = {
  columns: (typeof HEX_COLUMNS)[number];
  group: (typeof HEX_GROUPS)[number];
  lowerCase: boolean;
  offsets: boolean;
  ascii: boolean;
};

export const defaultHexFormat: HexFormat = {
  columns: "0",
  group: "1",
  lowerCase: false,
  offsets: false,
  ascii: false,
};

const ADDRESS_WIDTH = 16;
const SEPARATOR = "  ";

export function hexByteCount(pairs: string): number {
  return Math.floor((pairs.length + 1) / 3);
}

function hexWidth(bytes: number, group: number): number {
  return bytes === 0 ? 0 : bytes * 2 + Math.floor((bytes - 1) / group);
}

function hexLayout(format: HexFormat, count: number) {
  const columns = Number(format.columns) || Math.max(count, 1);
  const group = Number(format.group);
  const hexStart = format.offsets ? ADDRESS_WIDTH + SEPARATOR.length : 0;
  const asciiStart = hexStart + hexWidth(columns, group) + SEPARATOR.length;
  const stride =
    (format.ascii ? asciiStart + columns : asciiStart - SEPARATOR.length) + 1;
  return { columns, group, hexStart, asciiStart, stride };
}

export function formatStreamHex(
  pairs: string,
  byteStart: string,
  format: HexFormat,
): string {
  if (!pairs) return "";
  const count = hexByteCount(pairs);
  const { columns, group } = hexLayout(format, count);
  const address = format.offsets ? BigInt(byteStart) : 0n;
  const lines: string[] = [];
  for (let start = 0; start < count; start += columns) {
    const size = Math.min(count - start, columns);
    const raw = pairs.slice(start * 3, (start + size) * 3 - 1);
    let text = raw;
    if (group > 1) {
      const groups: string[] = [];
      for (let offset = 0; offset < size; offset += group) {
        groups.push(
          raw
            .slice(offset * 3, Math.min(offset + group, size) * 3 - 1)
            .replaceAll(" ", ""),
        );
      }
      text = groups.join(" ");
    }
    if (format.offsets) {
      const offset = (address + BigInt(start))
        .toString(16)
        .padStart(ADDRESS_WIDTH, "0");
      text =
        (format.lowerCase ? offset : offset.toUpperCase()) + SEPARATOR + text;
    }
    if (format.lowerCase) text = text.toLowerCase();
    if (format.ascii) {
      const ascii: string[] = [];
      for (let offset = 0; offset < size; offset++) {
        const byte = Number.parseInt(raw.slice(offset * 3, offset * 3 + 2), 16);
        ascii.push(byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".");
      }
      text +=
        " ".repeat(hexWidth(columns, group) - hexWidth(size, group)) +
        SEPARATOR +
        ascii.join("");
    }
    lines.push(text);
  }
  return lines.join("\n");
}

export type HexBoundary = { byte: number; ascii: boolean };

export function hexByteBoundary(
  character: number,
  count: number,
  format: HexFormat,
  end: boolean,
): HexBoundary {
  const { columns, group, hexStart, asciiStart, stride } = hexLayout(
    format,
    count,
  );
  const row = Math.floor(character / stride);
  const offset = character % stride;
  if (format.ascii && offset >= asciiStart)
    return {
      byte: Math.min(count, row * columns + offset - asciiStart),
      ascii: true,
    };

  const digit = Math.max(0, offset - hexStart);
  const groupWidth = group * 2 + 1;
  const partial = (digit % groupWidth) / 2;
  const inRow =
    Math.floor(digit / groupWidth) * group +
    (end ? Math.ceil(partial) : Math.floor(partial));
  return {
    byte: Math.min(count, row * columns + Math.min(columns, inRow)),
    ascii: false,
  };
}

export function hexCharacter(
  boundary: HexBoundary,
  count: number,
  format: HexFormat,
  end: boolean,
): number {
  const { columns, group, hexStart, asciiStart, stride } = hexLayout(
    format,
    count,
  );
  const after = boundary.byte > 0 && (end || boundary.byte === count);
  const index = boundary.byte - Number(after);
  if (!count) return 0;
  const row = Math.floor(index / columns);
  const column = index % columns;
  if (boundary.ascii && format.ascii)
    return row * stride + asciiStart + column + Number(after);
  return (
    row * stride +
    hexStart +
    column * 2 +
    Math.floor(column / group) +
    Number(after) * 2
  );
}
