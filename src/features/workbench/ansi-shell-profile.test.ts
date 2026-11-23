import { expect, it } from "vitest";
import { ansiShellCommand, ANSI_SHELL_TERMS } from "./ansi-shell-profile";

it("emits POSIX assignments for TERM, color and dimensions without submitting the shell line", () => {
  expect(
    ansiShellCommand(ANSI_SHELL_TERMS.truecolor, "truecolor", 24, 80),
  ).toBe("export TERM=xterm-256color COLORTERM=truecolor LINES=24 COLUMNS=80");
  expect(ansiShellCommand(ANSI_SHELL_TERMS.mono, "mono", 10, 100)).toBe(
    "export TERM=vt100 COLORTERM= LINES=10 COLUMNS=100",
  );
});

it("rejects terminal names or dimensions that could escape POSIX assignments", () => {
  for (const term of [
    "",
    "xterm\n",
    "xterm;other",
    "xterm > file",
    "xterm$(echo foo)",
    "'vt100'",
    "v".repeat(65),
  ]) {
    expect(ansiShellCommand(term, "indexed", 24, 80)).toBeUndefined();
  }
  for (const size of [0, 0.5, Number.NaN, 65_536]) {
    expect(ansiShellCommand("xterm", "basic", size, 80)).toBeUndefined();
    expect(ansiShellCommand("xterm", "basic", 24, size)).toBeUndefined();
  }
});
