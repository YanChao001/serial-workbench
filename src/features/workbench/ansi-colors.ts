import type { ITheme } from "@xterm/xterm";

export const ANSI_PALETTES = {
  light: {
    foreground: "#172034",
    background: "#ffffff",
    black: "#172034",
    red: "#9f202b",
    green: "#286838",
    yellow: "#825809",
    blue: "#284c9b",
    magenta: "#7d3e86",
    cyan: "#146575",
    white: "#4d5a70",
    brightBlack: "#66738a",
    brightRed: "#b62e42",
    brightGreen: "#367741",
    brightYellow: "#906011",
    brightBlue: "#3e5db6",
    brightMagenta: "#914691",
    brightCyan: "#14788c",
    brightWhite: "#233753",
  },
  dark: {
    foreground: "#e5ebf4",
    background: "#171e2c",
    black: "#232e40",
    red: "#fa787c",
    green: "#8ccf90",
    yellow: "#e9c479",
    blue: "#88aaff",
    magenta: "#d9a2ef",
    cyan: "#77cfdf",
    white: "#d0daeb",
    brightBlack: "#8091aa",
    brightRed: "#ffa1a5",
    brightGreen: "#b0e4a8",
    brightYellow: "#ffdc96",
    brightBlue: "#adc3ff",
    brightMagenta: "#edb9fb",
    brightCyan: "#9ee3ed",
    brightWhite: "#f7fbff",
  },
} satisfies Record<string, ITheme>;

const RESET = "\x1b[0m";
const RGB = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/;

type Color = readonly [number, number, number];

function rgb(value: string, background: Color): Color {
  const match = RGB.exec(value);
  if (!match) return background;
  const alpha = Number(match[4] ?? 1);
  const blend = (index: number, fallback: number) =>
    Math.round(Number(match[index]) * alpha + fallback * (1 - alpha));
  return [
    blend(1, background[0]),
    blend(2, background[1]),
    blend(3, background[2]),
  ];
}

function printable(value: string) {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) ? "" : character;
  }).join("");
}

/** The pinned DOM renderer has already applied theme, device palette and inverse colors. */
export function ansiColorSnapshot(root: HTMLElement): string | undefined {
  const rows = root.querySelector(".xterm-rows");
  const viewport = root.querySelector(".xterm-scrollable-element");
  const window = root.ownerDocument.defaultView;
  if (!rows?.children.length || !viewport || !window) return;
  const styleFor = (element: Element) => window.getComputedStyle(element);
  const background = rgb(styleFor(viewport).backgroundColor, [0, 0, 0]);
  let previous = "";
  function run(element: Element, value: string) {
    const style = styleFor(element);
    const text = printable(value);
    if (!text) return "";
    const visible =
      style.visibility === "hidden" ? " ".repeat(text.length) : text;
    const bg = rgb(style.backgroundColor, background);
    const fg = rgb(style.color, bg);
    const mode = `0;38;2;${fg.join(";")};48;2;${bg.join(";")}`;
    if (mode === previous) return visible;
    previous = mode;
    return `\x1b[${mode}m${visible}`;
  }
  const lines = Array.from(rows.children, (row) =>
    Array.from(row.childNodes, (child) =>
      run(
        child instanceof window.Element ? child : row,
        child.textContent ?? "",
      ),
    ).join(""),
  );
  return lines.join("\r\n") + RESET;
}
