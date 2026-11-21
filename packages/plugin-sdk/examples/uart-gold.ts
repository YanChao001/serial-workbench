import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";

const action = "example.terminal.uart.gold";
const nanosecondsPerSecond = 1_000_000_000n;
const maxSampleIndex = (1n << 64n) - 1n;

function decode(
  levels: string,
  samplesPerBit: number,
  windowStart: bigint,
  rate: bigint,
  signal: AbortSignal,
) {
  const frames = [];
  const midpoint = Math.floor(samplesPerBit / 2);
  // 金样使用空闲高电平、下降沿起始位和固定采样时钟。
  for (let start = 1; start < levels.length; start++) {
    signal.throwIfAborted();
    if (levels[start - 1] !== "1" || levels[start] !== "0") continue;
    const end = start + 10 * samplesPerBit;
    if (
      end > levels.length ||
      levels[start + midpoint] !== "0" ||
      levels[start + 9 * samplesPerBit + midpoint] !== "1"
    ) {
      throw new Error("Synthetic waveform has an incomplete or invalid frame");
    }
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (levels[start + (bit + 1) * samplesPerBit + midpoint] === "1")
        byte |= 1 << bit;
    }
    frames.push({
      byte,
      sampleStart: String(windowStart + BigInt(start)),
      sampleEnd: String(windowStart + BigInt(end)),
      startOffsetNs: String((BigInt(start) * nanosecondsPerSecond) / rate),
      endOffsetNs: String((BigInt(end) * nanosecondsPerSecond) / rate),
    });
    start = end - 1;
  }
  return frames;
}

export const register: NodeRegister = (context) => {
  context.actions.register(action, ({ params }, task) => {
    const { sampleClockId, sampleStart, sampleRateHz, baud, rx, tx } = params;
    if (
      typeof sampleClockId !== "string" ||
      typeof sampleStart !== "string" ||
      typeof sampleRateHz !== "string" ||
      typeof baud !== "string" ||
      typeof rx !== "string" ||
      typeof tx !== "string"
    ) {
      throw new Error("Synthetic waveform parameters are incomplete");
    }
    const rate = BigInt(sampleRateHz);
    const baudRate = BigInt(baud);
    const windowStart = BigInt(sampleStart);
    const windowEnd = windowStart + BigInt(rx.length);
    if (
      baudRate <= 0n ||
      rate % baudRate !== 0n ||
      rate / baudRate < 4n ||
      rate / baudRate > 64n ||
      rx.length !== tx.length ||
      rx[0] !== "1" ||
      tx[0] !== "1" ||
      windowEnd > maxSampleIndex
    ) {
      throw new Error("Synthetic waveform does not match its sample clock");
    }
    const samplesPerBit = Number(rate / baudRate);
    return {
      clock: {
        sampleClockId,
        sampleRateHz,
        sampleStart,
        sampleEnd: String(windowEnd),
      },
      rx: decode(rx, samplesPerBit, windowStart, rate, task.signal),
      tx: decode(tx, samplesPerBit, windowStart, rate, task.signal),
    };
  });
  return () => {};
};
