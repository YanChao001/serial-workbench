// 有序 MDF 4.10，仅使用一个同步通道组及未压缩数据块。
export type MeasurementChannel = {
  name: string;
  unit?: string;
  type: "float64" | "uint64" | "int64";
};
type Measurement = {
  startTimeNs: bigint;
  channels: readonly MeasurementChannel[];
  samples: readonly {
    elapsedNs: bigint;
    values: readonly (number | bigint | null)[];
  }[];
};

const commonHeaderSize = 24;
const scalarSize = 8;
const nanosPerSecond = 1_000_000_000;

type Block = {
  address: number;
  bytes: Buffer;
  data: Buffer;
};

function link(owner: Block, index: number, target: Block) {
  owner.bytes.writeBigUInt64LE(
    BigInt(target.address),
    commonHeaderSize + index * scalarSize,
  );
}

export function encodeMdf4({ startTimeNs, channels, samples }: Measurement) {
  const identification = Buffer.alloc(64);
  identification.write("MDF     4.10    SWB     ", "ascii");
  identification.writeUInt16LE(410, 28);
  const blocks: Block[] = [];
  let nextAddress = identification.length;

  function block(id: string, links: number, dataSize: number): Block {
    const start = commonHeaderSize + links * scalarSize;
    const bytes = Buffer.alloc(start + dataSize);
    bytes.write(id, "ascii");
    bytes.writeBigUInt64LE(BigInt(bytes.length), 8);
    bytes.writeBigUInt64LE(BigInt(links), 16);
    const address = nextAddress;
    nextAddress = Math.ceil((address + bytes.length) / 8) * 8;
    const result = { address, bytes, data: bytes.subarray(start) };
    blocks.push(result);
    return result;
  }

  function text(value: string) {
    const bytes = Buffer.from(value, "utf8");
    const entry = block("##TX", 0, Math.ceil((bytes.length + 1) / 8) * 8);
    bytes.copy(entry.data);
    return entry;
  }

  const header = block("##HD", 6, 32);
  const dataGroup = block("##DG", 4, 8);
  const channelGroup = block("##CG", 6, 32);
  header.data.writeBigUInt64LE(startTimeNs, 0);
  header.data[12] = 2; // 已知时区偏移为 0，头部存储 UTC。
  link(header, 0, dataGroup);
  link(dataGroup, 1, channelGroup);

  const columns: MeasurementChannel[] = [
    { name: "time", type: "float64", unit: "s" },
    { name: "elapsed_ns", type: "uint64", unit: "ns" },
    ...channels,
  ];
  let previousChannel: Block | undefined;
  for (const [index, column] of columns.entries()) {
    const channel = block("##CN", 8, 72);
    if (previousChannel) link(previousChannel, 0, channel);
    else link(channelGroup, 1, channel);
    previousChannel = channel;
    link(channel, 2, text(column.name));
    if (column.unit) link(channel, 6, text(column.unit));

    const { data } = channel;
    if (index === 0) {
      data[0] = 2; // 主通道。
      data[1] = 1; // 时间同步。
    }
    data[2] = { uint64: 0, int64: 2, float64: 4 }[column.type];
    data.writeUInt32LE(index * scalarSize, 4);
    data.writeUInt32LE(64, 8);
    if (index >= 2) {
      data.writeUInt32LE(2, 12); // 通道具有无效位。
      data.writeUInt32LE(index - 2, 16);
    }
  }

  const recordDataSize = columns.length * scalarSize;
  const invalidationSize = Math.ceil(channels.length / 8);
  const recordSize = recordDataSize + invalidationSize;
  channelGroup.data.writeBigUInt64LE(BigInt(samples.length), 8);
  channelGroup.data.writeUInt32LE(recordDataSize, 24);
  channelGroup.data.writeUInt32LE(invalidationSize, 28);
  const data = block("##DT", 0, samples.length * recordSize);
  link(dataGroup, 2, data);
  for (const [index, sample] of samples.entries()) {
    const row = index * recordSize;
    data.data.writeDoubleLE(Number(sample.elapsedNs) / nanosPerSecond, row);
    data.data.writeBigUInt64LE(sample.elapsedNs, row + scalarSize);
    for (const [column, value] of sample.values.entries()) {
      const offset = row + (column + 2) * scalarSize;
      if (value === null) {
        const byte = row + recordDataSize + Math.floor(column / 8);
        data.data[byte] = data.data[byte]! | (1 << (column % 8));
      } else if (typeof value === "number") {
        data.data.writeDoubleLE(value, offset);
      } else if (channels[column]!.type === "int64") {
        data.data.writeBigInt64LE(value, offset);
      } else {
        data.data.writeBigUInt64LE(value, offset);
      }
    }
  }

  const encoded = Buffer.alloc(data.address + data.bytes.length);
  identification.copy(encoded);
  for (const entry of blocks) entry.bytes.copy(encoded, entry.address);
  return encoded;
}
