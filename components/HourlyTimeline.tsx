import React from "react";
import { getHourlyPrecipLabel } from "@/lib/forecastHazards";
import { ScoredHour } from "@/lib/types";
import { cn, formatCompactHour, getCompactAqiCategory } from "@/lib/utils";

interface HourlyTimelineProps {
  hours: ScoredHour[];
  timeZone: string;
  highlightAqi?: boolean;
  plannedWindow?: {
    startTime: string;
    endTime: string;
    label: string;
  };
  alternateWindow?: {
    startTime: string;
    endTime: string;
    label: string;
  };
}

const styles = {
  good: "bg-pine text-white",
  caution: "bg-amber text-white",
  avoid: "bg-coral text-white"
};

const alertStyles = {
  "active-alert": "ring-2 ring-white/75",
  "recent-alert": "ring-2 ring-white/55",
  "recent-watch": "ring-2 ring-white/45"
};

type TimelineItem =
  | { type: "hour"; hour: ScoredHour }
  | { type: "divider"; id: string; label: string };

function overlapsWindow(
  hour: ScoredHour,
  window: { startTime: string; endTime: string } | undefined
) {
  if (!window) return false;
  const hourStart = new Date(hour.forecast.startTime).getTime();
  const hourEnd = new Date(hour.forecast.endTime).getTime();
  const windowStart = new Date(window.startTime).getTime();
  const windowEnd = new Date(window.endTime).getTime();
  return hourStart < windowEnd && hourEnd > windowStart;
}

function findWindowIndexRange(
  hours: ScoredHour[],
  window: { startTime: string; endTime: string } | undefined
) {
  if (!window) return null;
  const indexes = hours
    .map((hour, index) => (overlapsWindow(hour, window) ? index : -1))
    .filter((index) => index >= 0);

  if (!indexes.length) return null;

  return {
    start: indexes[0],
    end: indexes[indexes.length - 1]
  };
}

function buildTimelineItems(
  hours: ScoredHour[],
  plannedWindow?: { startTime: string; endTime: string; label: string },
  alternateWindow?: { startTime: string; endTime: string; label: string }
): TimelineItem[] {
  if (!plannedWindow) {
    return hours.map((hour) => ({ type: "hour" as const, hour }));
  }

  const selectedIndexes = new Set<number>();
  const plannedRange = findWindowIndexRange(hours, plannedWindow);
  const alternateRange = findWindowIndexRange(hours, alternateWindow);

  const addRange = (start: number, end: number) => {
    for (let index = Math.max(0, start); index <= Math.min(hours.length - 1, end); index += 1) {
      selectedIndexes.add(index);
    }
  };

  if (plannedRange) {
    addRange(plannedRange.start - 3, plannedRange.end + 3);
  }

  if (alternateRange) {
    addRange(alternateRange.start - 2, alternateRange.end + 2);
  }

  const sortedIndexes = [...selectedIndexes].sort((a, b) => a - b);
  const items: TimelineItem[] = [];
  const alternateIsLongRange =
    plannedRange &&
    alternateRange &&
    new Date(alternateWindow!.startTime).getTime() - new Date(plannedWindow.startTime).getTime() >=
      48 * 60 * 60 * 1000;

  sortedIndexes.forEach((index, position) => {
    if (position > 0 && index - sortedIndexes[position - 1] > 1) {
      items.push({
        type: "divider",
        id: `divider-${sortedIndexes[position - 1]}-${index}`,
        label: alternateIsLongRange
          ? "Later available option (longer-range forecast)"
          : "Later available option"
      });
    }

    items.push({
      type: "hour",
      hour: hours[index]
    });
  });

  return items;
}

export function HourlyTimeline({
  hours,
  timeZone,
  highlightAqi = false,
  plannedWindow,
  alternateWindow
}: HourlyTimelineProps) {
  const items = buildTimelineItems(hours, plannedWindow, alternateWindow);

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-panel">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink">Hourly timeline</h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            Green hours are your best bet. Yellow means use caution. Red means avoid this period if you can.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-mist px-4 py-3 text-sm leading-6 text-slate-700">
        <span className="font-semibold text-ink">Score guide:</span> Good: 80-100. Caution: 40-79. Avoid: 0-39. Severe hazards may lower scores significantly, including warnings, tornado risk, severe storms, flooding, ice, extreme heat/cold, and dangerous AQI.
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item) => {
          if (item.type === "divider") {
            return (
              <div
                key={item.id}
                className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-center text-sm font-medium text-slate-600"
              >
                {item.label}
              </div>
            );
          }

          const { hour } = item;
          const apparentTemperature = hour.forecast.apparentTemperatureF;
          const temperature = hour.forecast.temperatureF;
          const showFeelsLike =
            apparentTemperature !== null &&
            temperature !== null &&
            Math.abs(apparentTemperature - temperature) >= 3;
          const showGusts =
            hour.forecast.windGustMph !== null && hour.forecast.windGustMph >= 20;
          const showVisibility =
            hour.forecast.visibilityMiles !== null && hour.forecast.visibilityMiles < 5;
          const showHumidity =
            hour.reasons.includes("oppressive humidity") ||
            hour.reasons.includes("humid air may make it feel worse");
          const aqiValue = hour.forecast.aqi ?? hour.airQuality?.aqi ?? null;
          const aqiCategory = hour.forecast.aqiCategory ?? hour.airQuality?.category ?? null;
          const aqiInfluencedScore =
            hour.hasAqiImpact ||
            hour.reasons.some((reason) => {
              const normalized = reason.toLowerCase();
              return normalized.includes("air quality") || normalized.includes("aqi");
            });
          const showAqi =
            aqiValue !== null &&
            (aqiValue > 50 || aqiInfluencedScore || highlightAqi);
          const compactAqiCategory = getCompactAqiCategory(aqiCategory);
          const aqiToneClass =
            aqiValue !== null && aqiValue >= 151
              ? "border-rose-200/35 bg-rose-100/20 text-white"
              : aqiValue !== null && aqiValue >= 101
                ? "border-orange-200/35 bg-orange-100/20 text-white"
                : "border-amber-200/35 bg-amber-100/20 text-white";
          const inPlannedWindow = overlapsWindow(hour, plannedWindow);
          const inAlternateWindow = overlapsWindow(hour, alternateWindow);
          const precipLabel = getHourlyPrecipLabel(
            hour.forecast,
            hour.forecast.detailedForecast ?? "",
            timeZone
          );

          return (
            <div
              key={hour.forecast.startTime}
              className={cn(
                "rounded-2xl p-4 transition",
                styles[hour.classification],
                hour.alertContext ? alertStyles[hour.alertContext] : "",
                inPlannedWindow ? "ring-2 ring-ink/70" : "",
                inAlternateWindow ? "ring-2 ring-sky/80 ring-offset-2" : ""
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs uppercase tracking-[0.2em] text-white/80">
                  {formatCompactHour(hour.forecast.startTime, timeZone)}
                </div>
                {hour.alertLabel ? (
                  <span className="rounded-full bg-white/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                    {hour.alertLabel}
                  </span>
                ) : null}
              </div>
              <div className="mt-2 text-2xl font-semibold">{hour.score}</div>
              <div className="mt-1 text-sm font-medium capitalize">{hour.classification}</div>
              <div className="mt-3 text-sm text-white/85">
                {temperature !== null ? `${temperature}F` : "Temp n/a"}
              </div>
              {showFeelsLike ? (
                <div className="mt-1 text-xs text-white/80">Feels like {apparentTemperature}F</div>
              ) : null}
              <div className="mt-1 text-xs text-white/80">
                {hour.forecast.precipitationChance !== null
                  ? `${hour.forecast.precipitationChance}% ${precipLabel}`
                  : "Precip n/a"}
              </div>
              {showGusts ? (
                <div className="mt-1 text-xs text-white/80">
                  Gusts {hour.forecast.windGustMph} mph
                </div>
              ) : null}
              {showVisibility ? (
                <div className="mt-1 text-xs text-white/80">
                  Visibility {hour.forecast.visibilityMiles} mi
                </div>
              ) : null}
              {showHumidity ? (
                <div className="mt-1 text-xs text-white/80">
                  {hour.forecast.dewpointF !== null
                    ? `Dew point ${hour.forecast.dewpointF}F`
                    : hour.forecast.relativeHumidityPercent !== null
                      ? `${hour.forecast.relativeHumidityPercent}% humidity`
                      : "Humid conditions"}
                </div>
              ) : null}
              {showAqi ? (
                <div
                  className={cn(
                    "mt-1 inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
                    aqiToneClass
                  )}
                >
                  {`AQI ${aqiValue}${compactAqiCategory ? ` ${compactAqiCategory}` : ""}`}
                </div>
              ) : null}
              {hour.alertContext ? (
                <div className="mt-2 text-[11px] uppercase tracking-[0.14em] text-white/80">
                  {hour.alertContext === "active-alert"
                    ? "Alert in effect"
                    : hour.alertContext === "recent-watch"
                      ? "Recent watch"
                      : "Recent alert"}
                </div>
              ) : null}
              {inPlannedWindow ? (
                <div className="mt-2 text-[11px] uppercase tracking-[0.14em] text-white/85">
                  {plannedWindow?.label}
                </div>
              ) : null}
              {!inPlannedWindow && inAlternateWindow ? (
                <div className="mt-2 text-[11px] uppercase tracking-[0.14em] text-white/85">
                  {alternateWindow?.label}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
