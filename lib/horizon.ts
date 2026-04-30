import { ForecastHour, TimeHorizon } from "@/lib/types";
import { getZonedDateParts, isSameZonedDay } from "@/lib/utils";

const horizonLimits: Record<TimeHorizon, number> = {
  today: 24,
  tonight: 24,
  "24h": 24,
  "48h": 48
};

export function filterForecastHoursForHorizon(
  hours: ForecastHour[],
  horizon: TimeHorizon,
  timeZone: string,
  now = new Date()
) {
  const futureHours = hours.filter((hour) => new Date(hour.endTime) >= now);
  const nowParts = getZonedDateParts(now, timeZone);
  const nowLocalDateKey = `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}-${String(
    nowParts.day
  ).padStart(2, "0")}`;
  const tomorrow = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));
  const tomorrowParts = {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate()
  };
  const tomorrowLocalDateKey = `${tomorrowParts.year}-${String(tomorrowParts.month).padStart(2, "0")}-${String(
    tomorrowParts.day
  ).padStart(2, "0")}`;

  if (horizon === "today") {
    return futureHours.filter((hour) => {
      const start = new Date(hour.startTime);
      return (
        start >= now &&
        isSameZonedDay(start, now, timeZone) &&
        getZonedDateParts(start, timeZone).hour < 20
      );
    });
  }

  if (horizon === "tonight") {
    return futureHours.filter((hour) => {
      const start = new Date(hour.startTime);
      if (start < now) return false;

      const startParts = getZonedDateParts(start, timeZone);
      const startLocalDateKey = `${startParts.year}-${String(startParts.month).padStart(2, "0")}-${String(
        startParts.day
      ).padStart(2, "0")}`;
      const isSameDayAsNow = startLocalDateKey === nowLocalDateKey;
      const isFollowingLocalDay = startLocalDateKey === tomorrowLocalDateKey;

      if (nowParts.hour < 20) {
        return (
          (isSameDayAsNow && startParts.hour >= 20) ||
          (isFollowingLocalDay && startParts.hour < 6)
        );
      }

      return (
        (isSameDayAsNow && startParts.hour >= 20) ||
        (isFollowingLocalDay && startParts.hour < 6)
      );
    });
  }

  return futureHours.slice(0, horizonLimits[horizon]);
}
