const MINUTE_IN_MILLISECONDS = 60_000;
const DAY_IN_MILLISECONDS = 24 * 60 * MINUTE_IN_MILLISECONDS;
const MAXIMUM_BUSINESS_WINDOWS = 1_000;

type BusinessHours = { start: string; end: string };

export type AddBusinessMinutesInput = {
  from: Date;
  minutes: number;
  timeZone: string;
  businessDays: number[];
  businessHours: BusinessHours;
};

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type LocalDateTime = LocalDate & {
  hour: number;
  minute: number;
  second: number;
};

type BusinessCalendar = {
  businessDays: Set<number>;
  businessHours: { start: number; end: number };
  formatter: Intl.DateTimeFormat;
};

export function addBusinessMinutes(input: AddBusinessMinutesInput): Date {
  const calendar = createBusinessCalendar(input);
  let remainingMilliseconds = input.minutes * MINUTE_IN_MILLISECONDS;
  let current = nextBusinessInstant(input.from, calendar);

  while (remainingMilliseconds > 0) {
    const localDate = getLocalDateTime(current, calendar.formatter);
    const closing = localDateTimeToInstant(
      localDate,
      calendar.businessHours.end,
      calendar
    );
    const availableMilliseconds = closing.getTime() - current.getTime();

    if (availableMilliseconds <= 0) {
      current = nextBusinessInstant(closing, calendar);
      continue;
    }

    if (remainingMilliseconds <= availableMilliseconds) {
      return new Date(current.getTime() + remainingMilliseconds);
    }

    remainingMilliseconds -= availableMilliseconds;
    current = nextBusinessInstant(closing, calendar);
  }

  return current;
}

function createBusinessCalendar(input: AddBusinessMinutesInput): BusinessCalendar {
  if (!(input.from instanceof Date) || !Number.isFinite(input.from.getTime())) {
    throw new RangeError("from must be a valid Date.");
  }

  if (
    !Number.isSafeInteger(input.minutes) ||
    input.minutes <= 0 ||
    !Number.isSafeInteger(input.minutes * MINUTE_IN_MILLISECONDS)
  ) {
    throw new RangeError("minutes must be a positive whole number.");
  }

  if (!Array.isArray(input.businessDays) || input.businessDays.length === 0) {
    throw new RangeError("businessDays must contain at least one weekday.");
  }

  const businessDays = new Set(input.businessDays);
  if (
    businessDays.size !== input.businessDays.length ||
    [...businessDays].some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new RangeError("businessDays must contain unique weekdays from 0 through 6.");
  }

  const start = parseTime(input.businessHours?.start, "businessHours.start");
  const end = parseTime(input.businessHours?.end, "businessHours.end");
  if (start >= end) {
    throw new RangeError("businessHours.start must be earlier than businessHours.end.");
  }
  assertSupportedCalculationRange(input.minutes, end - start);

  if (typeof input.timeZone !== "string" || input.timeZone.trim().length === 0) {
    throw new RangeError("timeZone must be a valid IANA time zone.");
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: input.timeZone,
      year: "numeric",
      era: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    throw new RangeError("timeZone must be a valid IANA time zone.");
  }

  return { businessDays, businessHours: { start, end }, formatter };
}

function assertSupportedCalculationRange(minutes: number, businessWindowMinutes: number): void {
  if (Math.ceil(minutes / businessWindowMinutes) > MAXIMUM_BUSINESS_WINDOWS) {
    throw new RangeError(
      `minutes exceed the supported calendar range of ${MAXIMUM_BUSINESS_WINDOWS} business windows.`
    );
  }
}

function nextBusinessInstant(from: Date, calendar: BusinessCalendar): Date {
  let localDate: LocalDate = getLocalDateTime(from, calendar.formatter);

  while (true) {
    if (calendar.businessDays.has(getWeekday(localDate))) {
      const opening = localDateTimeToInstant(localDate, calendar.businessHours.start, calendar);
      const closing = localDateTimeToInstant(localDate, calendar.businessHours.end, calendar);

      if (closing <= opening) {
        throw new RangeError("business hours do not create a valid local business window.");
      }

      if (from < opening) {
        return opening;
      }

      if (from < closing) {
        return new Date(from.getTime());
      }
    }

    localDate = nextLocalDate(localDate);
  }
}

function localDateTimeToInstant(
  localDate: LocalDate,
  timeInMinutes: number,
  calendar: BusinessCalendar
): Date {
  const target: LocalDateTime = {
    ...localDate,
    hour: Math.floor(timeInMinutes / 60),
    minute: timeInMinutes % 60,
    second: 0
  };
  const utcGuess = getUtcMilliseconds(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );
  const offsets = new Set([
    getTimeZoneOffset(utcGuess, calendar.formatter),
    getTimeZoneOffset(utcGuess - DAY_IN_MILLISECONDS, calendar.formatter),
    getTimeZoneOffset(utcGuess + DAY_IN_MILLISECONDS, calendar.formatter)
  ]);
  const candidates = [...offsets].map((offset) => {
    const instant = utcGuess - offset;
    return { instant, localDateTime: getLocalDateTime(new Date(instant), calendar.formatter) };
  });
  const exactCandidates = candidates.filter((candidate) =>
    compareLocalDateTimes(candidate.localDateTime, target) === 0
  );

  if (exactCandidates.length > 0) {
    return new Date(Math.min(...exactCandidates.map((candidate) => candidate.instant)));
  }

  const nextCompatibleCandidate = candidates
    .filter((candidate) => compareLocalDateTimes(candidate.localDateTime, target) > 0)
    .sort((left, right) =>
      compareLocalDateTimes(left.localDateTime, right.localDateTime) || left.instant - right.instant
    )[0];

  if (!nextCompatibleCandidate) {
    throw new RangeError("business hours cannot be resolved in the configured time zone.");
  }

  return new Date(nextCompatibleCandidate.instant);
}

function getTimeZoneOffset(instant: number, formatter: Intl.DateTimeFormat): number {
  const local = getLocalDateTime(new Date(instant), formatter);
  return getUtcMilliseconds(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  ) - instant;
}

function getLocalDateTime(date: Date, formatter: Intl.DateTimeFormat): LocalDateTime {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const hour = requirePart(values, "hour");
  return {
    year: toProlepticGregorianYear(values),
    month: requirePart(values, "month"),
    day: requirePart(values, "day"),
    hour: hour === 24 ? 0 : hour,
    minute: requirePart(values, "minute"),
    second: requirePart(values, "second")
  };
}

function requirePart(
  values: Partial<Record<Intl.DateTimeFormatPartTypes, string>>,
  part: Intl.DateTimeFormatPartTypes
): number {
  const value = Number(values[part]);
  if (!Number.isInteger(value)) {
    throw new RangeError(`Unable to read ${part} in the configured time zone.`);
  }

  return value;
}

function toProlepticGregorianYear(
  values: Partial<Record<Intl.DateTimeFormatPartTypes, string>>
): number {
  const year = requirePart(values, "year");
  const era = values.era;

  if (era === "AD") {
    return year;
  }

  if (era === "BC") {
    return 1 - year;
  }

  throw new RangeError("Unable to read the Gregorian era in the configured time zone.");
}

function compareLocalDateTimes(left: LocalDateTime, right: LocalDateTime): number {
  return (
    left.year - right.year ||
    left.month - right.month ||
    left.day - right.day ||
    left.hour - right.hour ||
    left.minute - right.minute ||
    left.second - right.second
  );
}

function getWeekday(date: LocalDate): number {
  return new Date(getUtcMilliseconds(date.year, date.month - 1, date.day)).getUTCDay();
}

function nextLocalDate(date: LocalDate): LocalDate {
  const next = new Date(
    getUtcMilliseconds(date.year, date.month - 1, date.day) + DAY_IN_MILLISECONDS
  );
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function getUtcMilliseconds(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function parseTime(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RangeError(`${label} must be an HH:mm time.`);
  }

  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
