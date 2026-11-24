/// <reference lib="esnext.temporal" />

type CalendarOccurrences = {
  nextOccurrence(afterMs: number, throughMs: number): number | undefined;
};

export type CalendarSchedule = CalendarOccurrences &
  ({ kind: "once"; atMs: number } | { kind: "cron" });

const offsetDateTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseCalendarInstant(at: unknown): number {
  if (
    typeof at !== "string" ||
    !offsetDateTime.test(at) ||
    at.endsWith("-00:00")
  )
    throw new Error("A one-time schedule requires a date and known UTC offset");

  const resolved = Date.parse(at);
  if (!Number.isFinite(resolved))
    throw new Error("A one-time schedule requires a real date");
  const suffix = at.slice(-6);
  const offset = at.endsWith("Z")
    ? 0
    : (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4))) *
      (suffix.startsWith("-") ? -60_000 : 60_000);
  // 日历规格拒绝浏览器将不存在的日期自动挪到下个月。
  if (
    new Date(resolved + offset).toISOString().slice(0, 19) !== at.slice(0, 19)
  )
    throw new Error("A one-time schedule requires a real date");
  return resolved;
}

function oneTimeSchedule(at: unknown): CalendarSchedule {
  const occurrence = parseCalendarInstant(at);
  return {
    kind: "once",
    atMs: occurrence,
    nextOccurrence(afterMs, throughMs) {
      return afterMs < occurrence && occurrence <= throughMs
        ? occurrence
        : undefined;
    },
  };
}

const monthNames = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};
const weekdayNames = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const cronSegment =
  /^(\*|[0-9]{1,2}|[A-Z]{3})(?:-([0-9]{1,2}|[A-Z]{3}))?(?:\/([1-9][0-9]?))?$/;

function cronValues(
  field: string,
  label: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> = {},
): number[] {
  const isWeekday = names === weekdayNames;
  const values = new Set<number>();
  const invalid = () => new Error("Invalid cron " + label);
  const valueOf = (text: string) => {
    const value = names[text] ?? Number(text);
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw invalid();
    return value;
  };

  for (const segment of field.toUpperCase().split(",")) {
    const match = cronSegment.exec(segment);
    const first = match?.[1];
    if (!match || first === undefined) throw invalid();
    const [, , last, every] = match;
    if (first === "*" && last !== undefined) throw invalid();
    const start = first === "*" ? minimum : valueOf(first);
    let end = first === "*" || every ? maximum : start;
    if (last !== undefined) {
      end = isWeekday && last === "SUN" && start > 0 ? 7 : valueOf(last);
    }
    if (end < start) throw invalid();

    const step = every === undefined ? 1 : Number(every);
    for (let value = start; value <= end; value += step)
      values.add(isWeekday && value === 7 ? 0 : value);
  }
  return [...values].sort((a, b) => a - b);
}

function namedTimeZone(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(value)
  )
    throw new Error("Cron requires a named IANA time zone");
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    throw new Error("Unknown cron time zone");
  }
}

function cronSchedule(expression: unknown, zone: unknown): CalendarSchedule {
  if (typeof expression !== "string" || expression.length > 160)
    throw new Error("Cron requires five fields");
  const fields = expression.trim().split(/[ \t]+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    fields.length !== 5 ||
    !minute ||
    !hour ||
    !dayOfMonth ||
    !month ||
    !dayOfWeek
  )
    throw new Error("Cron requires five fields");

  const zoneId = namedTimeZone(zone);
  const minutes = cronValues(minute, "minute", 0, 59);
  const hours = cronValues(hour, "hour", 0, 23);
  const dates = cronValues(dayOfMonth, "day of month", 1, 31);
  const months = cronValues(month, "month", 1, 12, monthNames);
  const weekdays = cronValues(dayOfWeek, "day of week", 0, 7, weekdayNames);

  const matchesDay = (date: Temporal.PlainDate) => {
    if (!months.includes(date.month)) return false;
    const matchesDate = dates.includes(date.day);
    const matchesWeekday = weekdays.includes(date.dayOfWeek % 7);
    if (dates.length === 31) return matchesWeekday;
    if (weekdays.length === 7) return matchesDate;
    return matchesDate || matchesWeekday;
  };

  return {
    kind: "cron",
    nextOccurrence(afterMs, throughMs) {
      if (throughMs <= afterMs) return undefined;
      const after =
        Temporal.Instant.fromEpochMilliseconds(afterMs).toZonedDateTimeISO(
          zoneId,
        );
      const start = after.toPlainDate();
      // 用 UTC 日期设搜索上界，也覆盖跨午夜的时区回拨。
      const end = Temporal.Instant.fromEpochMilliseconds(throughMs)
        .toZonedDateTimeISO("UTC")
        .toPlainDate()
        .add({ days: 1 });
      for (
        let date = start;
        Temporal.PlainDate.compare(date, end) <= 0;
        date = date.add({ days: 1 })
      ) {
        if (!matchesDay(date)) continue;
        const isStart = date.equals(start);
        for (const hour of hours) {
          for (const minute of minutes) {
            if (isStart && hour * 60 + minute <= after.hour * 60 + after.minute)
              continue;
            const local = date.toPlainDateTime({ hour, minute });
            const zoned = local.toZonedDateTime(zoneId, {
              disambiguation: "earlier",
            });
            // 落在时区跳跃缺口内时，Temporal 会返回不同的本地时间。
            if (!local.equals(zoned.toPlainDateTime())) continue;
            const occurrence = zoned.epochMilliseconds;
            if (occurrence > afterMs)
              return occurrence <= throughMs ? occurrence : undefined;
          }
        }
      }
      return undefined;
    },
  };
}

export function compileCalendarSchedule(value: unknown): CalendarSchedule {
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "once" && "at" in value)
      return oneTimeSchedule(value.at);
    if (value.kind === "cron" && "expression" in value && "timeZone" in value)
      return cronSchedule(value.expression, value.timeZone);
  }
  throw new Error("Invalid calendar schedule");
}
