export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join(" ");
}

/** UTF-16 offsets suitable for selecting the invalid text in a browser input. */
export class HexInputError extends Error {
  readonly start: number;
  readonly end: number;

  constructor(start: number, end: number) {
    super("HEX input must contain complete bytes and ASCII whitespace only");
    this.start = start;
    this.end = end;
  }
}

export function parseHex(input: string): Uint8Array {
  const bytes: number[] = [];
  for (const match of input.matchAll(/[^\t\n\v\f\r ]+/g)) {
    const token = match[0];
    const invalid = token.search(/[^0-9a-f]/i);
    if (invalid !== -1) {
      const start = match.index + invalid;
      const width = (input.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
      throw new HexInputError(start, start + width);
    }
    if (token.length % 2 !== 0) {
      const end = match.index + token.length;
      throw new HexInputError(end - 1, end);
    }
    for (let offset = 0; offset < token.length; offset += 2) {
      bytes.push(Number.parseInt(token.slice(offset, offset + 2), 16));
    }
  }
  return Uint8Array.from(bytes);
}
