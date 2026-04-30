import SunCalc from "suncalc";
import { ForecastHour } from "@/lib/types";
import {
  formatDateInputValue,
  getZonedHour,
  zonedDateTimeToIso
} from "@/lib/utils";

interface DaylightCoordinates {
  latitude?: number | null;
  longitude?: number | null;
}

interface DaylightFallbackOptions {
  fallbackIsDaytime?: boolean | null;
}

export type DaylightWindowTier = "daylight" | "mixed-light" | "night";

function hasCoordinates(coordinates: DaylightCoordinates) {
  return (
    typeof coordinates.latitude === "number" &&
    Number.isFinite(coordinates.latitude) &&
    typeof coordinates.longitude === "number" &&
    Number.isFinite(coordinates.longitude)
  );
}

function addDay(dateValue: string) {
  const next = new Date(`${dateValue}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function getApproximateDaylightOverlapRatio(
  startTime: string,
  endTime: string,
  timeZone: string,
  fallbackIsDaytime?: boolean | null
) {
  if (typeof fallbackIsDaytime === "boolean") {
    return fallbackIsDaytime ? 1 : 0;
  }

  const startHour = getZonedHour(startTime, timeZone);
  const endHour = getZonedHour(endTime, timeZone);
  const normalizedEndHour = endHour === 0 ? 24 : endHour;
  const daylightStart = 7;
  const daylightEnd = 20;
  const overlapStart = Math.max(startHour, daylightStart);
  const overlapEnd = Math.min(normalizedEndHour, daylightEnd);
  const totalHours =
    (new Date(endTime).getTime() - new Date(startTime).getTime()) / (60 * 60 * 1000);

  if (totalHours <= 0) {
    return 0;
  }

  return Math.max(0, overlapEnd - overlapStart) / totalHours;
}

function getSunTimeRangeForDate(
  dateIso: string,
  latitude: number,
  longitude: number,
  timeZone: string
) {
  const dayValue = formatDateInputValue(dateIso, timeZone);
  const [year, month, day] = dayValue.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const times = SunCalc.getTimes(anchor, latitude, longitude);

  if (
    !(times.sunrise instanceof Date) ||
    !(times.sunset instanceof Date) ||
    Number.isNaN(times.sunrise.getTime()) ||
    Number.isNaN(times.sunset.getTime())
  ) {
    return null;
  }

  return {
    date: dayValue,
    sunrise: times.sunrise.toISOString(),
    sunset: times.sunset.toISOString()
  };
}

export function getSunTimesForDate(
  dateIso: string,
  latitude?: number | null,
  longitude?: number | null,
  timeZone = "UTC"
) {
  if (!hasCoordinates({ latitude, longitude })) {
    return null;
  }

  try {
    return getSunTimeRangeForDate(dateIso, latitude!, longitude!, timeZone);
  } catch {
    return null;
  }
}

export function getDaylightOverlapRatio(
  startTime: string,
  endTime: string,
  latitude?: number | null,
  longitude?: number | null,
  timeZone = "UTC",
  options?: DaylightFallbackOptions
) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  if (!hasCoordinates({ latitude, longitude })) {
    return getApproximateDaylightOverlapRatio(
      startTime,
      endTime,
      timeZone,
      options?.fallbackIsDaytime
    );
  }

  try {
    let currentMs = startMs;
    let overlapMs = 0;

    while (currentMs < endMs) {
      const currentIso = new Date(currentMs).toISOString();
      const currentDate = formatDateInputValue(currentIso, timeZone);
      const nextDate = addDay(currentDate);
      const nextBoundaryMs = new Date(
        zonedDateTimeToIso(nextDate, "00:00", timeZone)
      ).getTime();
      const segmentEndMs = Math.min(endMs, nextBoundaryMs);
      const sunTimes = getSunTimeRangeForDate(
        currentIso,
        latitude!,
        longitude!,
        timeZone
      );

      if (!sunTimes) {
        overlapMs +=
          getApproximateDaylightOverlapRatio(
            new Date(currentMs).toISOString(),
            new Date(segmentEndMs).toISOString(),
            timeZone,
            options?.fallbackIsDaytime
          ) *
          (segmentEndMs - currentMs);
      } else {
        const sunriseMs = new Date(sunTimes.sunrise).getTime();
        const sunsetMs = new Date(sunTimes.sunset).getTime();
        const segmentOverlap = Math.max(
          0,
          Math.min(segmentEndMs, sunsetMs) - Math.max(currentMs, sunriseMs)
        );
        overlapMs += segmentOverlap;
      }

      currentMs = segmentEndMs;
    }

    return overlapMs / (endMs - startMs);
  } catch {
    return getApproximateDaylightOverlapRatio(
      startTime,
      endTime,
      timeZone,
      options?.fallbackIsDaytime
    );
  }
}

export function isDaylightHour(
  hour: Pick<ForecastHour, "startTime" | "endTime" | "isDaytime">,
  latitude?: number | null,
  longitude?: number | null,
  timeZone = "UTC"
) {
  // We use slightly different thresholds on purpose:
  // - 50% for an individual forecast hour so sunrise/sunset edge hours still count naturally.
  // - 60% for a "mostly daylight" window used in selection logic.
  // - 70% for the user-facing daylight tier so "daylight" reads as clearly daylight-dominant.
  return (
    getDaylightOverlapRatio(
      hour.startTime,
      hour.endTime,
      latitude,
      longitude,
      timeZone,
      {
        fallbackIsDaytime: hour.isDaytime
      }
    ) >= 0.5
  );
}

export function isMostlyDaylightWindow(
  startTime: string,
  endTime: string,
  latitude?: number | null,
  longitude?: number | null,
  timeZone = "UTC"
) {
  return (
    getDaylightOverlapRatio(startTime, endTime, latitude, longitude, timeZone) >= 0.6
  );
}

export function getDaylightWindowTier(
  startTime: string,
  endTime: string,
  latitude?: number | null,
  longitude?: number | null,
  timeZone = "UTC",
  options?: DaylightFallbackOptions
): DaylightWindowTier {
  const ratio = getDaylightOverlapRatio(
    startTime,
    endTime,
    latitude,
    longitude,
    timeZone,
    options
  );

  if (ratio >= 0.7) return "daylight";
  if (ratio >= 0.3) return "mixed-light";
  return "night";
}
