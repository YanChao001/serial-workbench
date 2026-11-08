import { describe, expect, it } from "vitest";
import { IncrementalUtf8 } from "./utf8";

describe("IncrementalUtf8", () => {
  it("preserves text at every byte split, including within multibyte characters", () => {
    const bytes = Uint8Array.of(
      0x41,
      0xc2,
      0xa2,
      0xe4,
      0xb8,
      0xad,
      0xf0,
      0x9f,
      0x98,
      0x80,
      0x5a,
    );
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new IncrementalUtf8();
      const text =
        decoder.push(bytes.subarray(0, split), false) +
        decoder.push(bytes.subarray(split), false);
      expect(text, `split ${split}`).toBe("A¢中😀Z");
    }
  });

  it("keeps incomplete characters across several calls", () => {
    const decoder = new IncrementalUtf8();
    expect(decoder.push(Uint8Array.of(0xf0), false)).toBe("");
    expect(decoder.push(Uint8Array.of(0x9f), false)).toBe("");
    expect(decoder.push(Uint8Array.of(0x98), false)).toBe("");
    expect(decoder.push(Uint8Array.of(0x80), false)).toBe("😀");
  });

  it("discards a pending character before decoding a new source boundary", () => {
    const decoder = new IncrementalUtf8();
    expect(decoder.push(Uint8Array.of(0xe4, 0xb8), false)).toBe("");
    expect(decoder.push(Uint8Array.of(0xad, 0x42), true)).toBe("�B");
    expect(decoder.push(Uint8Array.of(0xe4, 0xb8, 0xad), false)).toBe("中");
  });

  it("resets pending bytes even when a gap or seek supplies no bytes", () => {
    const decoder = new IncrementalUtf8();
    decoder.push(Uint8Array.of(0xc2), false);
    expect(decoder.push(new Uint8Array(), true)).toBe("");
    expect(decoder.push(Uint8Array.of(0xa2), false)).toBe("�");
  });

  it("replaces malformed bytes without losing subsequent valid text", () => {
    const decoder = new IncrementalUtf8();
    expect(decoder.push(Uint8Array.of(0xff, 0xe4, 0x41), false)).toBe("��A");
  });
});
