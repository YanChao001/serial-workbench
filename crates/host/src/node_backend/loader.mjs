import { readSync } from "node:fs";

// Windows命令行有独立长度上限；可信内嵌脚本复用私有管道首帧，不写临时文件。
function readExactly(length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, bytes, offset, length - offset, null);
    if (count === 0)
      throw new Error("Backend bootstrap ended before completion");
    offset += count;
  }
  return bytes;
}

const length = readExactly(4).readUInt32LE();
if (length === 0 || length > 1_048_576)
  throw new Error("Backend bootstrap exceeds its frame budget");
// 精确消费首帧，随后bootstrap的原stdin读者接管控制消息，不吞下一帧字节。
await import(
  `data:text/javascript;base64,${readExactly(length).toString("base64")}`
);
