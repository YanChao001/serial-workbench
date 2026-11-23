const MAX_ECHO_LENGTH = 4_096;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function appendAnsiLocalEcho(previous: string, input: string): string {
  if (input === "\x7f" || input === "\b") {
    if (!previous || previous.endsWith("\n")) return previous;
    const last = graphemes.segment(previous).containing(previous.length - 1);
    return last ? previous.slice(0, last.index) : previous;
  }

  if (input === "\r") input = "\n";
  const first = input.charCodeAt(0);
  if (
    input !== "\n" &&
    input !== "\t" &&
    !(first >= 32 && (first < 127 || first > 159))
  )
    return previous;

  const next = previous + input;
  if (next.length <= MAX_ECHO_LENGTH) return next;
  const cut = next.length - MAX_ECHO_LENGTH;
  const boundary = graphemes.segment(next).containing(cut - 1);
  return next.slice(boundary ? boundary.index + boundary.segment.length : cut);
}
