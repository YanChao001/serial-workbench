import { checksumBytes } from "../../src/wire-checksum.ts";
import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";

export const nmeaLimits = { text: 8192, sentences: 32, sentence: 256 } as const;

type SentenceType = "GGA" | "RMC" | "GSA" | "GSV" | "VTG";
type NmeaValue = string | number | null;
type ParseValue = (raw: string) => NmeaValue | undefined;
type Span = { start: number; end: number };
type RawField = Span & { raw: string };
type NmeaField = RawField & { id: string; value: NmeaValue } & (
    { unit: string } | Record<never, never>
  );
type NmeaLine = { line: number } & (
  | {
      status: "decoded";
      talker: string;
      type: SentenceType;
      checksum: string;
      fields: NmeaField[];
    }
  | { status: "invalid"; path: string; start: number; end: number }
  | { status: "unsupported"; talker: string; type: string }
);

class NmeaLineError extends ProtocolFieldError {
  readonly start: number;
  readonly end: number;

  constructor(path: string, start: number, end: number) {
    super(path, "Invalid NMEA sentence");
    this.start = start;
    this.end = end;
  }
}

function integer(min: number, max: number): ParseValue {
  return (raw) => {
    if (!/^-?\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return value >= min && value <= max ? value : undefined;
  };
}

function decimal(min = 0, max = Infinity): ParseValue {
  return (raw) => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max
      ? value
      : undefined;
  };
}

function optional(parse: ParseValue): ParseValue {
  return (raw) => (raw === "" ? null : parse(raw));
}

function oneOf(values: string): ParseValue {
  return (raw) => (raw.length === 1 && values.includes(raw) ? raw : undefined);
}

const mode: ParseValue = (raw) => (/^[A-Z]$/.test(raw) ? raw : undefined);
const hexId: ParseValue = (raw) =>
  /^[0-9A-Fa-f]$/.test(raw) ? Number.parseInt(raw, 16) : undefined;
const utcTime = optional((raw) => {
  const match = /^(\d{2})(\d{2})(\d{2})(\.\d+)?$/.exec(raw);
  if (!match) return undefined;
  const [, hours, minutes, seconds, fraction] = match;
  const maxSecond = hours === "23" && minutes === "59" ? 60 : 59;
  return Number(hours) <= 23 &&
    Number(minutes) <= 59 &&
    Number(seconds) <= maxSecond
    ? `${hours}:${minutes}:${seconds}${fraction ?? ""}`
    : undefined;
});
const utcDate = optional((raw) => {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const [, day, month, year] = match;
  const days = [
    31,
    Number(year) % 4 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const monthDays = days[Number(month) - 1];
  return monthDays !== undefined && Number(day) >= 1 && Number(day) <= monthDays
    ? `${day}-${month}-${year}`
    : undefined;
});

function coordinate(latitude: boolean): ParseValue {
  return (raw) => {
    if (raw === ",") return null;
    const match = (
      latitude
        ? /^(\d{2})(\d{2}(?:\.\d+)?),([NS])$/
        : /^(\d{3})(\d{2}(?:\.\d+)?),([EW])$/
    ).exec(raw);
    if (!match) return undefined;
    const degrees = Number(match[1]);
    const minutes = Number(match[2]);
    const limit = latitude ? 90 : 180;
    if (degrees > limit || minutes >= 60 || (degrees === limit && minutes > 0))
      return undefined;
    const value = degrees + minutes / 60;
    return value !== 0 && (match[3] === "S" || match[3] === "W")
      ? -value
      : value;
  };
}

const dec = optional(decimal());
const angle = optional(decimal(0, 360));
const satellite = optional(integer(1, 999));

function splitFields(line: string, start: number, end: number) {
  const fields: Span[] = [];
  for (const raw of line.slice(start, end).split(",")) {
    const fieldEnd = start + raw.length;
    fields.push({ start, end: fieldEnd });
    start = fieldEnd + 1;
  }
  return fields;
}

function isSentenceType(value: string): value is SentenceType {
  return (
    value === "GGA" ||
    value === "RMC" ||
    value === "GSA" ||
    value === "GSV" ||
    value === "VTG"
  );
}

function readFields(
  line: string,
  start: number,
  end: number,
  type: SentenceType,
) {
  const source = splitFields(line, start, end);
  const fields: NmeaField[] = [];
  function count(min: number, max = min) {
    if (source.length < min || source.length > max)
      throw new NmeaLineError("fields", start, end);
  }
  function add(
    id: string,
    index: number,
    parse: ParseValue,
    unit?: string,
    width = 1,
  ) {
    const first = source[index]!;
    const last = source[index + width - 1]!;
    const raw = line.slice(first.start, last.end);
    const value = parse(raw);
    if (value === undefined) throw new NmeaLineError(id, first.start, last.end);
    fields.push({
      id,
      value,
      raw,
      start: first.start,
      end: last.end,
      ...(unit === undefined ? {} : { unit }),
    });
    return value;
  }
  function measurement(
    id: string,
    index: number,
    unit: string,
    code: string,
    parse: ParseValue,
  ) {
    const reading = add(id, index, parse, unit);
    add(
      `${id}Unit`,
      index + 1,
      reading === null ? optional(oneOf(code)) : oneOf(code),
    );
  }
  function position(index: number) {
    add("latitude", index, coordinate(true), "deg", 2);
    add("longitude", index + 2, coordinate(false), "deg", 2);
  }
  switch (type) {
    case "GGA":
      count(14);
      add("utcTime", 0, utcTime);
      position(1);
      add("fixQuality", 5, integer(0, 9));
      add("satellitesUsed", 6, integer(0, 99));
      add("hdop", 7, dec);
      measurement("altitude", 8, "m", "M", optional(decimal(-Infinity)));
      measurement(
        "geoidSeparation",
        10,
        "m",
        "M",
        optional(decimal(-Infinity)),
      );
      add("differentialAge", 12, dec, "s");
      add(
        "differentialStationId",
        13,
        optional((raw) => (/^\d{1,4}$/.test(raw) ? raw : undefined)),
      );
      break;
    case "RMC": {
      count(11, 13);
      add("utcTime", 0, utcTime);
      add("dataStatus", 1, oneOf("AV"));
      position(2);
      add("speedKnots", 6, dec, "kn");
      add("trueCourse", 7, angle, "deg");
      add("utcDate", 8, utcDate);
      const variation = add(
        "magneticVariation",
        9,
        optional(decimal(0, 180)),
        "deg",
      );
      add(
        "magneticVariationDirection",
        10,
        variation === null ? optional(oneOf("EW")) : oneOf("EW"),
      );
      if (source.length >= 12) add("positionMode", 11, optional(mode));
      if (source.length === 13) add("navigationStatus", 12, optional(mode));
      break;
    }
    case "GSA":
      count(17, 18);
      add("selectionMode", 0, oneOf("AM"));
      add("fixType", 1, integer(1, 3));
      for (let index = 0; index < 12; index++)
        add(`satelliteId[${index + 1}]`, index + 2, satellite);
      add("pdop", 14, dec);
      add("hdop", 15, dec);
      add("vdop", 16, dec);
      if (source.length === 18) add("systemId", 17, optional(hexId));
      break;
    case "GSV": {
      count(3, 20);
      const total = add("totalMessages", 0, integer(1, 9));
      add("messageNumber", 1, integer(1, Number(total)));
      add("satellitesInView", 2, integer(0, 99));
      const extra = (source.length - 3) % 4;
      if (extra > 1)
        throw new NmeaLineError("satellites", source[3]!.start, end);
      const groupsEnd = source.length - extra;
      for (let index = 3; index < groupsEnd; index += 4) {
        const satelliteIndex = (index - 3) / 4 + 1;
        add(`satelliteId[${satelliteIndex}]`, index, satellite);
        add(
          `elevation[${satelliteIndex}]`,
          index + 1,
          optional(integer(-90, 90)),
          "deg",
        );
        add(
          `azimuth[${satelliteIndex}]`,
          index + 2,
          optional(integer(0, 359)),
          "deg",
        );
        add(
          `signalStrength[${satelliteIndex}]`,
          index + 3,
          optional(integer(0, 99)),
          "dB-Hz",
        );
      }
      if (extra === 1) add("signalId", groupsEnd, optional(hexId));
      break;
    }
    case "VTG":
      count(8, 9);
      measurement("trueCourse", 0, "deg", "T", angle);
      measurement("magneticCourse", 2, "deg", "M", angle);
      measurement("speedKnots", 4, "kn", "N", dec);
      measurement("speedKilometers", 6, "km/h", "K", dec);
      if (source.length === 9) add("positionMode", 8, optional(mode));
      break;
  }
  return fields;
}

function parseLine(raw: string, line: number): NmeaLine {
  try {
    if (raw.length > nmeaLimits.sentence)
      throw new NmeaLineError("length", nmeaLimits.sentence, raw.length);
    const asAscii = raw.search(/[^\x20-\x7e]/);
    if (asAscii !== -1) throw new NmeaLineError("ascii", asAscii, asAscii + 1);
    const header = /^\$([A-Z]{2})([A-Z]{3}),/.exec(raw);
    if (!header) throw new NmeaLineError("header", 0, Math.min(7, raw.length));
    const star = raw.indexOf("*", header[0].length);
    const checksum = star === -1 ? "" : raw.slice(star + 1).toUpperCase();
    if (!/^[0-9A-F]{2}$/.test(checksum))
      throw new NmeaLineError(
        "checksum",
        star === -1 ? raw.length : star + 1,
        raw.length,
      );
    const content = new TextEncoder().encode(raw.slice(1, star));
    if (
      checksumBytes(content, "xor", "big")[0] !== Number.parseInt(checksum, 16)
    )
      throw new NmeaLineError("checksum", star + 1, raw.length);
    const talker = header[1]!;
    const type = header[2]!;
    if (!isSentenceType(type))
      return { line, status: "unsupported", talker, type };
    return {
      line,
      status: "decoded",
      talker,
      type,
      checksum,
      fields: readFields(raw, header[0].length, star, type),
    };
  } catch (error) {
    if (error instanceof NmeaLineError)
      return {
        line,
        status: "invalid",
        path: error.path,
        start: error.start,
        end: error.end,
      };
    throw error;
  }
}

export function parseNmeaText(text: unknown): {
  status: "parsed";
  lines: NmeaLine[];
} {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > nmeaLimits.text
  )
    throw new ProtocolFieldError("text", "Expected bounded NMEA text");
  const lines: NmeaLine[] = [];
  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    if (raw === "") continue;
    if (lines.length === nmeaLimits.sentences)
      throw new ProtocolFieldError("text", "Too many NMEA sentences");
    lines.push(parseLine(raw, index + 1));
  }
  if (lines.length === 0)
    throw new ProtocolFieldError("text", "Missing NMEA sentences");
  return { status: "parsed", lines };
}
