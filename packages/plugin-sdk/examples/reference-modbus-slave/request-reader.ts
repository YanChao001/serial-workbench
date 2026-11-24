import {
  modbusFrameLimits,
  type ModbusTransport,
} from "../reference-protocol-fields/modbus-frame.ts";

type RxChunk = { bytes: Uint8Array; eventSeq: string; byteStart: string };
export type RequestFrame = {
  bytes: Uint8Array;
  eventStart: string;
  eventEnd: string;
  byteStart: string;
  byteEnd: string;
};

export class ModbusRequestReader {
  readonly #transport: ModbusTransport;
  readonly #buffer: Uint8Array;
  #start: { eventSeq: string; byte: bigint } | undefined;
  #size = 0;
  #length: number | undefined;
  #fault = false;

  constructor(transport: ModbusTransport) {
    this.#transport = transport;
    this.#buffer = new Uint8Array(modbusFrameLimits[transport]);
  }

  get fault() {
    return this.#fault;
  }

  get partial() {
    return this.#size > 0;
  }

  #reset() {
    this.#start = undefined;
    this.#size = 0;
    this.#length = undefined;
  }

  #readBinaryLength() {
    if (this.#transport === "tcp" && this.#size === 6) {
      const length = (this.#buffer[4]! << 8) | this.#buffer[5]!;
      if (
        this.#buffer[2] !== 0 ||
        this.#buffer[3] !== 0 ||
        length < 2 ||
        length > 254
      )
        this.#fault = true;
      else this.#length = length + 6;
    }
    if (this.#transport !== "rtu") return;
    const code = this.#buffer[1]!;
    if (this.#size === 2) {
      if (code >= 1 && code <= 6) this.#length = 8;
      else if (code !== 15 && code !== 16) this.#fault = true;
    } else if (this.#size === 7 && this.#length === undefined) {
      const length = this.#buffer[6]! + 9;
      if (length > this.#buffer.length) this.#fault = true;
      else this.#length = length;
    }
  }

  *consume(chunk: RxChunk): Generator<RequestFrame> {
    const firstByte = BigInt(chunk.byteStart);
    const eventEnd = String(BigInt(chunk.eventSeq) + 1n);
    for (const [offset, byte] of chunk.bytes.entries()) {
      if (this.#fault) return;
      if (this.#transport === "ascii") {
        if (byte === 0x3a) this.#reset();
        else if (this.#size === 0) continue;
      }
      this.#start ??= {
        eventSeq: chunk.eventSeq,
        byte: firstByte + BigInt(offset),
      };
      this.#buffer[this.#size++] = byte;
      this.#readBinaryLength();
      if (this.#fault) return;
      const asciiEnd =
        this.#transport === "ascii" &&
        byte === 0x0a &&
        this.#buffer[this.#size - 2] === 0x0d;
      if (asciiEnd || this.#size === this.#length) {
        const frame = {
          bytes: this.#buffer.slice(0, this.#size),
          eventStart: this.#start.eventSeq,
          eventEnd,
          byteStart: String(this.#start.byte),
          byteEnd: String(firstByte + BigInt(offset + 1)),
        };
        this.#reset();
        yield frame;
      } else if (this.#size === this.#buffer.length) {
        this.#reset();
      }
    }
  }
}
