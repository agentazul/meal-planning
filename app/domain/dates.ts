import { Temporal } from "@js-temporal/polyfill";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(value: string): Temporal.PlainDate {
  if (!dateOnlyPattern.test(value)) {
    throw new Error(`Expected a date in YYYY-MM-DD format, received "${value}"`);
  }

  return Temporal.PlainDate.from(value);
}

export function todayInTimezone(timezone: string): string {
  return Temporal.Now.zonedDateTimeISO(timezone).toPlainDate().toString();
}

export function getWeekStartDate(value: string): string {
  const date = parseDateOnly(value);
  const daysSinceSunday = date.dayOfWeek === 7 ? 0 : date.dayOfWeek;
  return date.subtract({ days: daysSinceSunday }).toString();
}

export function getWeekDates(weekStart: string): readonly string[] {
  const start = parseDateOnly(weekStart);

  return Array.from({ length: 7 }, (_, index) =>
    start.add({ days: index }).toString(),
  );
}

export function isDateInWeek(date: string, weekStart: string): boolean {
  return getWeekDates(weekStart).includes(parseDateOnly(date).toString());
}

export function formatDateLabel(
  value: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = parseDateOnly(value);
  const stableInstant = new Date(
    Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0),
  );

  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "UTC",
  }).format(stableInstant);
}
