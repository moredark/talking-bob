import { Temporal } from "@js-temporal/polyfill";
import {
  LocalDateParts,
  ScheduleSlot,
  getLocalDateParts,
  getLocalDateKey,
  resolveEffectiveTimeZone,
  resolveWallClock,
  validateScheduleTime,
} from "./timezone";

/** Weekday bits use ISO order: Monday = 1, ..., Sunday = 64. */
export const ALL_WEEKDAYS_MASK = 0b1111111;

export function validatePromptWeekdaysMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 1 || mask > ALL_WEEKDAYS_MASK) {
    throw new RangeError("Prompt weekdays mask must be an integer from 1 through 127");
  }
}

export function nextWeeklySlotAtOrAfter(now: Date, hour: number, minute: number, timeZone: string, mask: number): ScheduleSlot {
  return findNextWeeklySlot(now, hour, minute, timeZone, mask, false);
}

export function nextWeeklySlotStrictlyAfter(now: Date, hour: number, minute: number, timeZone: string, mask: number): ScheduleSlot {
  return findNextWeeklySlot(now, hour, minute, timeZone, mask, true);
}

export function weeklySlotOnDate(date: LocalDateParts, hour: number, minute: number, timeZone: string, mask: number): ScheduleSlot | null {
  validatePromptWeekdaysMask(mask);
  validateScheduleTime(hour, minute);
  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  const plainDate = Temporal.PlainDate.from(date, { overflow: "reject" });
  const weekdayBit = 1 << (plainDate.dayOfWeek - 1);
  if ((mask & weekdayBit) === 0 || !dateExistsInTimeZone(plainDate, effectiveTimeZone)) return null;
  const instant = resolveWallClock({ year: plainDate.year, month: plainDate.month, day: plainDate.day }, hour, minute, effectiveTimeZone);
  // A late-day gap must not transfer an occurrence onto another calendar date.
  const localDate = formatLocalDate(date);
  if (getLocalDateKey(instant, effectiveTimeZone) !== localDate) return null;
  return { instant, localDate, timeZone: effectiveTimeZone };
}

function findNextWeeklySlot(now: Date, hour: number, minute: number, timeZone: string, mask: number, strictlyAfter: boolean): ScheduleSlot {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("Date must be valid");
  validatePromptWeekdaysMask(mask);
  validateScheduleTime(hour, minute);
  const effectiveTimeZone = resolveEffectiveTimeZone(timeZone).timeZone;
  const today = getLocalDateParts(now, effectiveTimeZone);
  let date = Temporal.PlainDate.from(today);
  for (let offset = 0; offset < 14; offset += 1) {
    const slot = weeklySlotOnDate(date, hour, minute, effectiveTimeZone, mask);
    if (slot) {
      const difference = slot.instant.getTime() - now.getTime();
      if (strictlyAfter ? difference > 0 : difference >= 0) return slot;
    }
    date = date.add({ days: 1 });
  }
  throw new RangeError("Unable to find a weekly schedule slot");
}

function dateExistsInTimeZone(date: Temporal.PlainDate, timeZone: string): boolean {
  const probe = date.toPlainDateTime({ hour: 12 }).toZonedDateTime(timeZone, { disambiguation: "earlier" });
  return probe.year === date.year && probe.month === date.month && probe.day === date.day;
}

function formatLocalDate(value: LocalDateParts): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}
