import { isAnsiWindowDimension } from "./ansi-keyboard";

export const ANSI_SHELL_TERMS = {
  mono: "vt100",
  basic: "xterm",
  indexed: "xterm-256color",
  truecolor: "xterm-256color",
} as const;

export type ShellColorCapability = keyof typeof ANSI_SHELL_TERMS;

export function validShellTerm(term: string): boolean {
  return (
    term.length <= 64 &&
    /^[a-zA-Z0-9]/.test(term) &&
    !/[^a-zA-Z0-9._+-]/.test(term)
  );
}

export function ansiShellCommand(
  term: string,
  color: ShellColorCapability,
  rows: number,
  cols: number,
): string | undefined {
  if (!validShellTerm(term) || ![rows, cols].every(isAnsiWindowDimension))
    return;
  const colorterm = color === "truecolor" ? "truecolor" : "";
  return `export TERM=${term} COLORTERM=${colorterm} LINES=${rows} COLUMNS=${cols}`;
}
