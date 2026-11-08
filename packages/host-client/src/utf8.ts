export class IncrementalUtf8 {
  private decoder = new TextDecoder("utf-8");

  push(bytes: Uint8Array, boundary: boolean): string {
    // gap/seek 的新来源不能补全旧来源留下的半个字符。
    if (boundary) this.decoder = new TextDecoder("utf-8");
    return this.decoder.decode(bytes, { stream: true });
  }
}
