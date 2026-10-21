const DATE_PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();

export const DEFAULT_BUSINESS_TIMEZONE = 'Europe/Vienna';

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_PARTS_CACHE.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  DATE_PARTS_CACHE.set(timeZone, formatter);
  return formatter;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function normalizeBusinessTimeZone(timeZone?: string | null): string {
  const next = timeZone?.trim() || DEFAULT_BUSINESS_TIMEZONE;

  try {
    getDateFormatter(next).format(new Date());
    return next;
  } catch {
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

export function getZonedDateTimeParts(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): ZonedDateTimeParts {
  const formatter = getDateFormatter(normalizeBusinessTimeZone(timeZone));
  const parts = formatter.formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

export function buildDayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function getTimeZoneOffsetMs(
  date: Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): number {
  const parts = getZonedDateTimeParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtc - date.getTime();
}

export function getDayKey(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  const parts = getZonedDateTimeParts(date, timeZone);
  return buildDayKey(parts.year, parts.month, parts.day);
}

export function dayKeyToDate(
  dayKey: string,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  const normalizedTimeZone = normalizeBusinessTimeZone(timeZone);
  return zonedTimeToUtc(
    year,
    (month || 1) - 1,
    day || 1,
    0,
    0,
    0,
    normalizedTimeZone,
  );
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number = 0,
  minute: number = 0,
  second: number = 0,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  const normalizedTimeZone = normalizeBusinessTimeZone(timeZone);
  const baseUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let guessMs = baseUtcMs;

  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(guessMs), normalizedTimeZone);
    const nextGuess = baseUtcMs - offsetMs;
    if (nextGuess === guessMs) {
      break;
    }
    guessMs = nextGuess;
  }

  return new Date(guessMs);
}

export function getBusinessDayStartUtc(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  const parts = getZonedDateTimeParts(date, timeZone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

export function getDateKey(date: Date): string {
  return buildDayKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function getBusinessDate(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  return getBusinessDayStartUtc(date, timeZone);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

export function getBusinessHour(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): number {
  return getZonedDateTimeParts(date, timeZone).hour;
}

export function getBusinessMinute(
  date: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): number {
  return getZonedDateTimeParts(date, timeZone).minute;
}
