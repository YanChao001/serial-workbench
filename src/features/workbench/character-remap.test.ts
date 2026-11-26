import { describe, expect, it } from "vitest";
import { remapCharacters, type CharacterRemapRules } from "./character-remap";

const keep: CharacterRemapRules = {
  newline: "keep",
  backspace: "keep",
  letterCase: "keep",
  replacements: [],
};

describe("terminal character remapping", () => {
  it.each([
    ["cr", "A\rB\rC\rD"],
    ["lf", "A\nB\nC\nD"],
    ["crlf", "A\r\nB\r\nC\r\nD"],
  ] as const)(
    "treats CRLF as one boundary when mapping to %s",
    (newline, text) => {
      expect(
        remapCharacters("A\rB\nC\r\nD", { ...keep, newline }, 100),
      ).toEqual({
        ok: true,
        text,
      });
    },
  );

  it("applies BS to one Unicode scalar on its input line before substitutions", () => {
    expect(
      remapCharacters(
        "a🚀\b\r\n\bq\bß",
        {
          ...keep,
          backspace: "apply",
          letterCase: "upper",
          replacements: [
            { source: "a", replacement: "pq" },
            { source: "p", replacement: "!" },
          ],
        },
        100,
      ),
    ).toEqual({ ok: true, text: "PQ\r\nSS" });
    expect(
      remapCharacters("A\bB", { ...keep, backspace: "remove" }, 2),
    ).toEqual({ ok: true, text: "AB" });
  });

  it("rejects ambiguous rows and refuses to publish an over-budget output", () => {
    const source = "🚀";
    expect(
      remapCharacters(
        source,
        {
          ...keep,
          replacements: [
            { source, replacement: "abc" },
            { source, replacement: "" },
          ],
        },
        10,
      ),
    ).toEqual({
      ok: false,
      code: "rows",
      issues: [{ code: "duplicate", row: 1 }],
    });
    expect(remapCharacters("ß", { ...keep, letterCase: "upper" }, 1)).toEqual({
      ok: false,
      code: "output",
    });
    expect(
      remapCharacters(
        "a",
        { ...keep, replacements: [{ source: "\ud800", replacement: "" }] },
        10,
      ),
    ).toEqual({
      ok: false,
      code: "rows",
      issues: [{ code: "source", row: 0 }],
    });
  });
});
