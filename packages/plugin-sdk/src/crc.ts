export type CrcParameters = {
  width: number;
  polynomial: number;
  initial: number;
  reflectInput: boolean;
  reflectOutput: boolean;
  finalXor: number;
};

function reflect(value: number, width: number) {
  let mirrored = 0;
  for (let bit = 0; bit < width; bit++) {
    mirrored = (mirrored << 1) | (value & 1);
    value >>>= 1;
  }
  return mirrored >>> 0;
}

const reversedBytes = Uint8Array.from({ length: 256 }, (_, byte) =>
  reflect(byte, 8),
);

/** CRC RevEng direct-polynomial convention for validated 3- to 32-bit models. */
export function crcValue(bytes: Uint8Array, parameters: CrcParameters) {
  const { width, polynomial, initial, reflectInput, reflectOutput, finalXor } =
    parameters;
  const top = 1 << (width - 1);
  const mask = width === 32 ? -1 : (1 << width) - 1;
  let register = initial;
  for (const byte of bytes) {
    const bits = reflectInput ? reversedBytes[byte]! : byte;
    for (let input = 0x80; input !== 0; input >>>= 1) {
      const feedback = Boolean(register & top) !== Boolean(bits & input);
      register = ((register << 1) ^ (feedback ? polynomial : 0)) & mask;
    }
  }
  return (
    ((reflectOutput ? reflect(register, width) : register) ^ finalXor) >>> 0
  );
}
