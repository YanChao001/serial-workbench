import type { StreamReadResult } from "@serial-workbench/plugin-sdk/node";
import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import {
  compareModbusExchange,
  type ModbusUnitRouting,
} from "../reference-protocol-fields/modbus-exchange.ts";
import {
  modbusFrameLimits,
  type ModbusTransport,
} from "../reference-protocol-fields/modbus-frame.ts";

export type EventTime = StreamReadResult["events"][number]["time"];
type Offset = { event: string; byte: bigint };
type Start = Offset & { time: EventTime };
type Matched = {
  start: Start;
  end: Offset;
  time: EventTime;
  responseBase64: string;
} & (
  | { outcome: "matched" }
  | { outcome: "device_exception"; exceptionCode: number }
);
type Chunk = {
  bytes: Uint8Array;
  eventSeq: string;
  byteStart: string;
  time: EventTime;
};

export class ModbusResponseReader {
  readonly #request: Uint8Array;
  readonly #transport: ModbusTransport;
  readonly #routing: ModbusUnitRouting;
  readonly #buffer: Uint8Array;
  #start: Start | undefined;
  #size = 0;
  #length: number | undefined;
  #observedBytes = 0;
  #ignored = 0;
  #stopped = false;

  constructor(
    transport: ModbusTransport,
    request: Uint8Array,
    routing: ModbusUnitRouting,
  ) {
    this.#transport = transport;
    this.#request = request;
    this.#routing = routing;
    this.#buffer = new Uint8Array(modbusFrameLimits[transport]);
  }

  get ignoredFrames() {
    return this.#ignored;
  }

  get stopped() {
    return this.#stopped;
  }

  get hasPartialFrame() {
    return this.#size > 0;
  }

  #reset() {
    this.#size = 0;
    this.#length = undefined;
    this.#start = undefined;
  }

  // An invalid binary header gives no trustworthy boundary for the following bytes.
  #binaryLength() {
    if (this.#transport === "tcp" && this.#size === 6) {
      const length = (this.#buffer[4]! << 8) | this.#buffer[5]!;
      if (
        this.#buffer[2] !== 0 ||
        this.#buffer[3] !== 0 ||
        length < 2 ||
        length > 254
      )
        this.#stopped = true;
      else this.#length = length + 6;
    }
    if (this.#transport !== "rtu") return;
    const code = this.#buffer[1]!;
    if (this.#size === 2) {
      if (code > 0x80) this.#length = 5;
      else if (code === 5 || code === 6 || code === 15 || code === 16)
        this.#length = 8;
      else if (code < 1 || code > 4) this.#stopped = true;
    }
    if (this.#size === 3 && this.#length === undefined) {
      const count = this.#buffer[2]!;
      if (count === 0 || count > 250) this.#stopped = true;
      else this.#length = count + 5;
    }
  }

  consume(chunk: Chunk): Matched | undefined {
    const byteStart = BigInt(chunk.byteStart);
    for (const [index, byte] of chunk.bytes.entries()) {
      if (++this.#observedBytes > 16_384 || this.#ignored >= 32)
        this.#stopped = true;
      if (this.#stopped) return undefined;
      if (this.#transport === "ascii") {
        if (byte === 0x3a) {
          if (this.#size > 0) this.#ignored++;
          this.#reset();
        } else if (this.#size === 0) continue;
      }
      this.#start ??= {
        event: chunk.eventSeq,
        byte: byteStart + BigInt(index),
        time: chunk.time,
      };
      this.#buffer[this.#size++] = byte;
      this.#binaryLength();
      if (this.#stopped) return undefined;
      const asciiEnd =
        this.#transport === "ascii" &&
        byte === 0x0a &&
        this.#buffer[this.#size - 2] === 0x0d;
      if (!asciiEnd && this.#size !== this.#length) {
        if (this.#size === this.#buffer.length) {
          this.#ignored++;
          this.#reset();
        }
        continue;
      }
      const bytes = this.#buffer.subarray(0, this.#size);
      const start = this.#start;
      try {
        const match = compareModbusExchange(
          this.#transport,
          this.#request,
          bytes,
          this.#routing,
        );
        if (match.status === "matched" || match.status === "device-exception") {
          const source = {
            start,
            end: {
              event: String(BigInt(chunk.eventSeq) + 1n),
              byte: byteStart + BigInt(index + 1),
            },
            time: chunk.time,
            responseBase64: Buffer.from(bytes).toString("base64"),
          };
          this.#reset();
          return "exceptionCode" in match
            ? {
                ...source,
                outcome: "device_exception",
                exceptionCode: match.exceptionCode,
              }
            : { ...source, outcome: "matched" };
        }
      } catch (error) {
        if (!(error instanceof ProtocolFieldError)) throw error;
      }
      this.#ignored++;
      this.#reset();
    }
    return undefined;
  }
}
