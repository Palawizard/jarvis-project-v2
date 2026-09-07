/**
 * Calendar dates, kept lexical.
 *
 * An all-day event is a range of calendar DATES, not an interval of instants:
 * `2026-09-10` is the 10th for a caller in UTC+14 and for a caller in UTC-11
 * alike. Every helper here therefore works on `YYYY-MM-DD` components and
 * never lets `new Date(...)` decide which day a value names -- including the
 * silent normalisation that turns `2026-02-30` into the 2nd of March.
 */

/** A real Gregorian `YYYY-MM-DD`: right shape, and a day that actually exists. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Round-trip the components: only a date that survives UTC construction
  // unchanged existed in the first place, which is also what makes leap years
  // correct without a rule of their own.
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The same check, as a boundary guard. */
export function assertCalendarDate(value: string, what = 'date'): string {
  if (!isCalendarDate(value)) throw new Error(`invalid ${what}: ${value}`);
  return value;
}

/**
 * The calendar date a lexical date/instant string names.
 *
 * Reading the date off the front of the string (rather than through
 * `new Date(...).toISOString()`) is what keeps a positive or negative offset
 * from rolling the date to its neighbour. A string with no lexical date --
 * only a parseable instant -- falls back to that instant's UTC date.
 */
export function calendarDate(value: string): string {
  const lexical = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (lexical) return assertCalendarDate(lexical[1] as string);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

/** `days` calendar days after `date`, computed from its components so no zone can shift it. */
export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = assertCalendarDate(date).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
export function diffCalendarDays(to: string, from: string): number {
  const utc = (date: string): number => {
    const [year, month, day] = assertCalendarDate(date).split('-').map(Number) as [
      number,
      number,
      number,
    ];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * A local wall-clock ISO string carrying its own offset.
 *
 * Both meanings survive: the instant (for timed events) and the lexical
 * calendar date the human meant (for all-day ones). `new Date().toISOString()`
 * keeps only the first, which is how "today" became yesterday's date for
 * anyone west of UTC.
 */
export function localIso(date: Date): string {
  const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}
