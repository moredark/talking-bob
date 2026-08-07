import { Temporal } from "@js-temporal/polyfill";
import { DEFAULT_USER_TIMEZONE } from "../../config/limits.config";

export interface EffectiveTimeZone {
  timeZone: string;
  usedFallback: boolean;
  wasNormalized: boolean;
}

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export interface ScheduleSlot {
  instant: Date;
  localDate: string;
  timeZone: string;
}

export interface CalendarDayRange {
  start: Date;
  end: Date;
}

interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
}

const MAX_GAP_MINUTES = 48 * 60;

export function resolveEffectiveTimeZone(
  raw: string | null | undefined,
): EffectiveTimeZone {
  if (typeof raw === "string") {
    const trimmed = raw.trim();

    if (trimmed.length > 0) {
      try {
        const timeZone = new Intl.DateTimeFormat("en-US", {
          timeZone: trimmed,
        }).resolvedOptions().timeZone;

        return {
          timeZone,
          usedFallback: false,
          wasNormalized: trimmed !== raw || timeZone !== trimmed,
        };
      } catch {
        // Legacy invalid values are intentionally replaced without exposing them.
      }
    }
  }

  return {
    timeZone: DEFAULT_USER_TIMEZONE,
    usedFallback: true,
    wasNormalized: false,
  };
}

export function validateScheduleTime(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError("Schedule hour must be an integer from 0 through 23");
  }

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError("Schedule minute must be an integer from 0 through 59");
  }
}

export function getLocalDateParts(
  date: Date,
  timeZone: string,
): LocalDateParts {
  const parts = getLocalDateTimeParts(
    date,
    resolveEffectiveTimeZone(timeZone).timeZone,
  );

  return { year: parts.year, month: parts.month, day: parts.day };
}

export function getLocalDateKey(date: Date, timeZone: string): string {
  return formatLocalDate(getLocalDateParts(date, timeZone));
}

export function resolveWallClock(
  localDate: LocalDateParts,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  validateLocalDate(localDate);
  validateScheduleTime(hour, minute);

  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  let candidate = Temporal.PlainDateTime.from({
    ...localDate,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  for (
    let skippedMinutes = 0;
    skippedMinutes <= MAX_GAP_MINUTES;
    skippedMinutes += 1
  ) {
    const resolved = candidate.toZonedDateTime(effectiveTimeZone, {
      disambiguation: "earlier",
    });
    if (sameLocalDateTime(resolved, candidate)) {
      return new Date(resolved.epochMilliseconds);
    }
    candidate = candidate.add({ minutes: 1 });
  }

  throw new RangeError("Unable to resolve the requested wall-clock time");
}

export function nextSlotAtOrAfter(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string,
): ScheduleSlot {
  return findNextSlot(now, hour, minute, timeZone, false);
}

export function nextSlotStrictlyAfter(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string,
): ScheduleSlot {
  return findNextSlot(now, hour, minute, timeZone, true);
}

export function latestSlotAtOrBefore(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string,
): ScheduleSlot {
  assertValidDate(now);
  validateScheduleTime(hour, minute);

  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  const currentLocalDate = getLocalDateParts(now, effectiveTimeZone);
  const currentSlot = makeSlot(currentLocalDate, hour, minute, effectiveTimeZone);
  if (currentSlot.instant.getTime() <= now.getTime()) {
    return currentSlot;
  }

  return makeSlot(
    addCalendarDays(currentLocalDate, -1),
    hour,
    minute,
    effectiveTimeZone,
  );
}

export function getCalendarDayRange(
  timeZone: string,
  now: Date = new Date(),
): CalendarDayRange {
  assertValidDate(now);

  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  const currentLocalDate = getLocalDateParts(now, effectiveTimeZone);

  return {
    start: resolveWallClock(currentLocalDate, 0, 0, effectiveTimeZone),
    end: resolveWallClock(
      addCalendarDays(currentLocalDate, 1),
      0,
      0,
      effectiveTimeZone,
    ),
  };
}

function findNextSlot(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string,
  strictlyAfter: boolean,
): ScheduleSlot {
  assertValidDate(now);
  validateScheduleTime(hour, minute);

  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  const currentLocalDate = getLocalDateParts(now, effectiveTimeZone);
  const currentSlot = makeSlot(currentLocalDate, hour, minute, effectiveTimeZone);
  const difference = currentSlot.instant.getTime() - now.getTime();

  if (strictlyAfter ? difference > 0 : difference >= 0) {
    return currentSlot;
  }

  return makeSlot(
    addCalendarDays(currentLocalDate, 1),
    hour,
    minute,
    effectiveTimeZone,
  );
}

function makeSlot(
  localDate: LocalDateParts,
  hour: number,
  minute: number,
  timeZone: string,
): ScheduleSlot {
  return {
    instant: resolveWallClock(localDate, hour, minute, timeZone),
    localDate: formatLocalDate(localDate),
    timeZone,
  };
}

function getLocalDateTimeParts(
  date: Date,
  timeZone: string,
): LocalDateTimeParts {
  assertValidDate(date);
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO(timeZone);

  return {
    year: zoned.year,
    month: zoned.month,
    day: zoned.day,
    hour: zoned.hour,
    minute: zoned.minute,
  };
}

function addCalendarDays(value: LocalDateParts, days: number): LocalDateParts {
  const date = Temporal.PlainDate.from(value).add({ days });

  return {
    year: date.year,
    month: date.month,
    day: date.day,
  };
}

function validateLocalDate(value: LocalDateParts): void {
  if (
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    !Number.isInteger(value.day)
  ) {
    throw new RangeError("Local date must contain integer year, month, and day");
  }

  try {
    Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    throw new RangeError("Local date is invalid");
  }
}

function sameLocalDateTime(
  left: Pick<LocalDateTimeParts, keyof LocalDateTimeParts>,
  right: Pick<LocalDateTimeParts, keyof LocalDateTimeParts>,
): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function formatLocalDate(value: LocalDateParts): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("Date must be valid");
  }
}
