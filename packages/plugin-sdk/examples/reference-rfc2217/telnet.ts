export const telnet = {
  binary: 0,
  suppressGoAhead: 3,
  comPort: 44,
  end: 240,
  sub: 250,
  will: 251,
  wont: 252,
  do: 253,
  dont: 254,
  iac: 255,
} as const;

export type TelnetItem =
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "option"; verb: number; option: number }
  | { kind: "sub"; option: number; bytes: Uint8Array };

const maxSubnegotiation = 256;

export class TelnetDecoder {
  #state: "data" | "command" | "option" | "sub" | "sub-command" = "data";
  #verb = 0;
  #sub: number[] = [];

  push(input: Uint8Array): TelnetItem[] {
    const items: TelnetItem[] = [];
    const data = new Uint8Array(input.length);
    let start = 0;
    let length = 0;
    function flushData() {
      if (length > start) {
        items.push({ kind: "data", bytes: data.subarray(start, length) });
        start = length;
      }
    }

    for (const byte of input) {
      switch (this.#state) {
        case "data":
          if (byte === telnet.iac) this.#state = "command";
          else data[length++] = byte;
          break;
        case "command":
          if (byte === telnet.iac) {
            data[length++] = byte;
            this.#state = "data";
          } else if (byte >= telnet.will && byte <= telnet.dont) {
            this.#verb = byte;
            this.#state = "option";
          } else if (byte === telnet.sub) {
            this.#sub = [];
            this.#state = "sub";
          } else {
            this.#state = "data";
          }
          break;
        case "option":
          flushData();
          items.push({ kind: "option", verb: this.#verb, option: byte });
          this.#state = "data";
          break;
        case "sub":
          if (byte === telnet.iac) this.#state = "sub-command";
          else this.#append(byte);
          break;
        case "sub-command":
          if (byte === telnet.iac) {
            this.#append(byte);
            this.#state = "sub";
          } else if (byte === telnet.end && this.#sub.length > 0) {
            flushData();
            items.push({
              kind: "sub",
              option: this.#sub[0]!,
              bytes: Uint8Array.from(this.#sub.slice(1)),
            });
            this.#sub = [];
            this.#state = "data";
          } else {
            throw new Error("Invalid Telnet subnegotiation");
          }
          break;
      }
    }
    flushData();
    return items;
  }

  finish() {
    if (this.#state !== "data") throw new Error("Truncated Telnet command");
  }

  #append(byte: number) {
    if (this.#sub.length >= maxSubnegotiation)
      throw new Error("Telnet subnegotiation exceeds 256 bytes");
    this.#sub.push(byte);
  }
}

export function encodeTelnetData(data: Uint8Array) {
  let extra = 0;
  for (const byte of data) if (byte === telnet.iac) extra++;
  if (extra === 0) return data;
  const encoded = new Uint8Array(data.length + extra);
  let offset = 0;
  for (const byte of data) {
    encoded[offset++] = byte;
    if (byte === telnet.iac) encoded[offset++] = byte;
  }
  return encoded;
}
export function encodeSub(option: number, bytes: Uint8Array) {
  return Uint8Array.of(
    telnet.iac,
    telnet.sub,
    option,
    ...encodeTelnetData(bytes),
    telnet.iac,
    telnet.end,
  );
}
