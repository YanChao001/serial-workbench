export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join(" ");
}

export function parseHex(input: string): Uint8Array {
  const bytes: number[] = [];
  for (const token of input.split(/[\t\n\v\f\r ]+/)) {
    if (token.length === 0) continue;
    if (token.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(token)) {
      throw new Error(
        "HEX input must contain complete bytes and ASCII whitespace only",
      );
    }
    for (let offset = 0; offset < token.length; offset += 2) {
      bytes.push(Number.parseInt(token.slice(offset, offset + 2), 16));
    }
  }
  return Uint8Array.from(bytes);
}
