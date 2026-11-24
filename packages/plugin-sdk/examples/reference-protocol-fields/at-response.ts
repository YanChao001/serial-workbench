import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";

export const atLimits = { text: 8192, command: 512, lines: 64, line: 2048 };
export type AtResultFormat = "verbose" | "numeric";

type AtState = "idle" | "waiting" | "complete" | "data-mode" | "uncertain";
type AtLineKind =
  | "echo"
  | "response"
  | "result"
  | "urc"
  | "prompt"
  | "payload"
  | "data"
  | "ambiguous"
  | "invalid";
type AtLine = { line: number; raw: string; kind: AtLineKind } & (
  { code: string } | Record<never, never>
);

const numericResults = {
  "0": "OK",
  "1": "CONNECT",
  "2": "RING",
  "3": "NO CARRIER",
  "4": "ERROR",
  "6": "NO DIALTONE",
  "7": "BUSY",
  "8": "NO ANSWER",
} as const;
const basicResults = new Set<string>(Object.values(numericResults));
const registration = new Set(["+CREG", "+CGREG", "+CEREG", "+C5GREG"]);
const urcs = new Set([
  "+CBMI",
  "+CCWA",
  "+CCCM",
  "+CDSI",
  "+CGEV",
  "+CIEV",
  "+CLIP",
  "+CMTI",
  "+CRING",
  "+CUSD",
]);

type Command = { echo: string; responseCode?: string; callControl: boolean };
type PayloadRule =
  | { kind: "pdu"; octets: number; serviceCenter: boolean }
  | { kind: "unbounded" };

function commandContext(value: unknown): Command | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > atLimits.command ||
    !/^(?:AT(?:[A-Z0-9&+%#^*$ /].*)?|A\/)$/i.test(value) ||
    /[^\x20-\x7e]/.test(value)
  )
    throw new ProtocolFieldError("command", "Expected one AT command line");
  return {
    echo: value,
    responseCode: /^AT\s*([+^#%][A-Z][A-Z0-9_]*)/i
      .exec(value)?.[1]
      ?.toUpperCase(),
    callControl:
      /^AT\s*(?:D|[AHO](?=$|[0-9;])|\+(?:CHUP|CGDATA)(?=$|[=?]))/i.test(value),
  };
}

function resultCode(text: string, format: AtResultFormat) {
  if (/^\+(?:CME|CMS) ERROR:[ \t]*\S/i.test(text))
    return text.slice(0, text.indexOf(":")).toUpperCase();
  if (format === "numeric")
    return Object.hasOwn(numericResults, text)
      ? numericResults[text as keyof typeof numericResults]
      : undefined;
  const upper = text.toUpperCase();
  if (basicResults.has(upper)) return upper;
  if (/^CONNECT\s+\S/.test(upper)) return "CONNECT";
  return undefined;
}

function registrationKind(fields: string, expecting: boolean): AtLineKind {
  if (expecting && fields.startsWith("(")) return "response";
  if (/^\d+\s*,\s*\d+(?:\s*,|\s*$)/.test(fields))
    return expecting ? "response" : "ambiguous";
  return /^\d+(?:\s*$|\s*,\s*(?:"|,|$))/.test(fields) ? "urc" : "ambiguous";
}

function payloadRule(code: string, fields: string): PayloadRule | undefined {
  let length: string | undefined;
  switch (code) {
    case "+CMT":
      length = /^(?:"[^"]*"|[^,"]*)\s*,\s*(\d+)$/.exec(fields)?.[1];
      break;
    case "+CMGR":
      length = /^\d+\s*,\s*(?:(?:"[^"]*"|[^,"]*)\s*,\s*)?(\d+)$/.exec(
        fields,
      )?.[1];
      break;
    case "+CMGL":
      length = /^\d+\s*,\s*\d+\s*,\s*(?:(?:"[^"]*"|[^,"]*)\s*,\s*)?(\d+)$/.exec(
        fields,
      )?.[1];
      break;
    case "+CBM":
    case "+CDS":
      length = /^\d+$/.test(fields) ? fields : undefined;
      if (code === "+CDS" && length === undefined) return undefined;
      break;
    default:
      return undefined;
  }
  const octets = Number(length);
  return Number.isInteger(octets) && octets > 0 && octets <= 512
    ? { kind: "pdu", octets, serviceCenter: code !== "+CBM" }
    : { kind: "unbounded" };
}

function matchesPdu(text: string, rule: Extract<PayloadRule, { kind: "pdu" }>) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return false;
  const prefix = rule.serviceCenter
    ? 1 + Number.parseInt(text.slice(0, 2), 16)
    : 0;
  return text.length === (rule.octets + prefix) * 2;
}

const extendedLine = /^([+^#%][A-Z][A-Z0-9_]*):\s*(.*)$/i;

function invalidLine(raw: string) {
  if (raw.length > atLimits.line) return true;
  return Array.from(raw).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9) || code === 127;
  });
}

export function parseAtResponse(
  text: unknown,
  command: unknown = undefined,
  format: unknown = "verbose",
): { status: "parsed"; state: AtState; lines: AtLine[] } {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > atLimits.text
  )
    throw new ProtocolFieldError("text", "Expected a bounded AT sample");
  if (format !== "verbose" && format !== "numeric")
    throw new ProtocolFieldError(
      "format",
      "Expected verbose or numeric AT results",
    );
  const context = commandContext(command);
  let state: AtState = context ? "waiting" : "idle";
  let payload: PayloadRule | undefined;
  let echoSeen = false;
  const lines: AtLine[] = [];
  const source = text.split(/\r\n|\n|\r/);
  for (const [index, raw] of source.entries()) {
    const line = index + 1;
    const reading = raw.trim();
    const invalid = invalidLine(raw);
    if (
      reading === "" &&
      !invalid &&
      (index === source.length - 1 ||
        (state !== "data-mode" && payload?.kind !== "unbounded"))
    )
      continue;
    if (lines.length === atLimits.lines)
      throw new ProtocolFieldError("text", "Too many AT response lines");
    const add = (kind: AtLineKind, code?: string) => {
      lines.push({ line, raw, kind, ...(code === undefined ? {} : { code }) });
    };
    if (state === "data-mode") {
      add("data");
      continue;
    }
    if (payload) {
      if (!invalid && payload.kind === "pdu" && matchesPdu(reading, payload)) {
        add("payload", "PDU");
        payload = undefined;
      } else {
        add(invalid ? "invalid" : "payload");
        payload = { kind: "unbounded" };
        if (state !== "complete") state = "uncertain";
      }
      continue;
    }
    if (invalid) {
      add("invalid");
      continue;
    }
    const waiting = state === "waiting";
    if (waiting && !echoSeen && reading === context?.echo.trim()) {
      echoSeen = true;
      add("echo");
      continue;
    }
    if (reading === ">") {
      add("prompt");
      continue;
    }
    const result = resultCode(reading, format);
    if (result !== undefined) {
      if (result === "RING" || (result === "NO CARRIER" && !waiting))
        add("urc", result);
      else if (result === "NO CARRIER" && !context?.callControl)
        add("ambiguous", result);
      else {
        add("result", result);
        if (result === "CONNECT") state = "data-mode";
        else if (waiting) state = "complete";
      }
      continue;
    }
    const extra = extendedLine.exec(reading);
    if (extra) {
      const code = extra[1]!.toUpperCase();
      const fields = extra[2]!;
      const expecting = waiting && context?.responseCode === code;
      if (registration.has(code))
        add(registrationKind(fields, expecting), code);
      else {
        const response =
          expecting &&
          (code !== "+CUSD" || fields.startsWith("(")) &&
          (!["+CLIP", "+CCWA"].includes(code) || !fields.startsWith('"'));
        if (response) add("response", code);
        else if (
          urcs.has(code) ||
          code === "+CMT" ||
          code === "+CBM" ||
          code === "+CDS"
        )
          add("urc", code);
        else add("ambiguous", code);
        payload = payloadRule(code, fields);
      }
      continue;
    }
    add(waiting ? "response" : "ambiguous");
  }
  if (lines.length === 0)
    throw new ProtocolFieldError("text", "Missing AT response lines");
  if (payload && state !== "complete") state = "uncertain";
  return { status: "parsed", state, lines };
}
