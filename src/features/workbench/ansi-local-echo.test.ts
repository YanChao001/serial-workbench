import { describe, expect, it } from "vitest";
import { appendAnsiLocalEcho } from "./ansi-local-echo";

describe("ANSI local keyboard echo", () => {
  it("shows typed text and basic editing without interpreting terminal controls", () => {
    const keys = [
      "a",
      "e\u0301",
      "\x7f",
      "\t",
      "b",
      "\r",
      "\b",
      "\x1b[A",
      "\x01",
      "\u009b",
      "z",
      "",
    ];
    expect(keys.reduce(appendAnsiLocalEcho, "")).toBe("a\tb\nz");
  });

  it("drops complete graphemes when the retained input outgrows the limit", () => {
    const tail = "x".repeat(4_095);
    expect(appendAnsiLocalEcho("e\u0301", tail)).toBe(tail);
    expect(appendAnsiLocalEcho(tail, "🙂")).toBe("x".repeat(4_094) + "🙂");
  });
});
