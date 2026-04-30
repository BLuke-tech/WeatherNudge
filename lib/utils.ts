import { clsx } from "clsx";

export function cn(...values: Array<string | false | null | undefined>) {
  return clsx(values);
}

export function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function isValidZipCode(value: string) {
  return /^\d{5}$/.test(value.trim());
}

export function isValidCityStateQuery(value: string) {
  return /^[A-Za-z0-9.'\-\s]+,\s*[A-Za-z]{2}$/.test(value.trim());
}

export function isValidUsLocationQuery(value: string) {
  const trimmed = value.trim();
  return isValidZipCode(trimmed) || isValidCityStateQuery(trimmed);
}

function getFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions
) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...options
  });
}

export function getZonedDateParts(dateInput: string | Date, timeZone: string) {
  const formatter = getFormatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date(dateInput));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: map.weekday
  };
}

export function isSameZonedDay(
  dateA: string | Date,
  dateB: string | Date,
  timeZone: string
) {
  const first = getZonedDateParts(dateA, timeZone);
  const second = getZonedDateParts(dateB, timeZone);

  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day
  );
}

export function getZonedHour(dateInput: string | Date, timeZone: string) {
  return getZonedDateParts(dateInput, timeZone).hour;
}

export function getZonedLocalHourKey(dateInput: string | Date, timeZone: string) {
  const parts = getZonedDateParts(dateInput, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}`;
}

export function formatZonedTime(dateInput: string | Date, timeZone: string) {
  return getFormatter(timeZone, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(dateInput));
}

function formatZonedDateLabel(dateInput: string | Date, timeZone: string) {
  return getFormatter(timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(dateInput));
}

export function formatHourRange(startIso: string, endIso: string, timeZone: string) {
  const sameDay = isSameZonedDay(startIso, endIso, timeZone);

  const startDateLabel = formatZonedDateLabel(startIso, timeZone);
  const endDateLabel = formatZonedDateLabel(endIso, timeZone);
  const startTime = formatZonedTime(startIso, timeZone);
  const endTime = formatZonedTime(endIso, timeZone);

  return sameDay
    ? `${startDateLabel} ${startTime} - ${endTime}`
    : `${startDateLabel} ${startTime} - ${endDateLabel} ${endTime}`;
}

export function formatCompactHour(startIso: string, timeZone: string) {
  return getFormatter(timeZone, {
    hour: "numeric"
  }).format(new Date(startIso));
}

export function formatClockTime(iso: string, timeZone: string) {
  return formatZonedTime(iso, timeZone);
}

export function formatDateInputValue(dateInput: string | Date, timeZone: string) {
  const parts = getZonedDateParts(dateInput, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function zonedDateTimeToIso(
  dateValue: string,
  timeValue: string,
  timeZone: string
) {
  const [yearRaw, monthRaw, dayRaw] = dateValue.split("-").map(Number);
  const [hourRaw, minuteRaw] = timeValue.split(":").map(Number);

  if (
    !yearRaw ||
    !monthRaw ||
    !dayRaw ||
    Number.isNaN(hourRaw) ||
    Number.isNaN(minuteRaw)
  ) {
    throw new Error("Please enter a valid event date and time.");
  }

  const targetUtcMillis = Date.UTC(yearRaw, monthRaw - 1, dayRaw, hourRaw, minuteRaw);
  let guessMillis = targetUtcMillis;

  for (let index = 0; index < 4; index += 1) {
    const zoned = getZonedDateParts(new Date(guessMillis), timeZone);
    const zonedUtcMillis = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute
    );
    const diff = targetUtcMillis - zonedUtcMillis;
    guessMillis += diff;

    if (diff === 0) {
      break;
    }
  }

  return new Date(guessMillis).toISOString();
}

export function titleCase(value: string) {
  return value
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .replace(/(['-])([a-z])/g, (_, punctuation: string, letter: string) => `${punctuation}${letter.toUpperCase()}`)
    .replace(/\bMc([a-z])/g, (_, letter: string) => `Mc${letter.toUpperCase()}`);
}

export function getAqiMeaning(aqi: number) {
  if (aqi <= 50) return "Air quality is generally fine for most people.";
  if (aqi <= 100) return "Sensitive groups may want shorter outdoor sessions.";
  if (aqi <= 150) return "Consider limiting time outside, especially for exercise.";
  if (aqi <= 200) return "Outdoor time is not a great choice for most people.";
  return "Air quality is poor enough that staying indoors is the safer call.";
}

export function getCompactAqiCategory(category: string | null | undefined) {
  if (!category || category === "Good") return null;
  if (category === "Moderate") return "Mod.";
  if (category === "Unhealthy for Sensitive Groups") return "USG";
  return category;
}
