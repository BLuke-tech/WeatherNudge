import React from "react";
import { getActivityConfig } from "@/lib/activityConfig";
import { DecisionResponse } from "@/lib/types";
import { formatHourRange } from "@/lib/utils";

interface RecommendationCardProps {
  result: DecisionResponse;
}

export function RecommendationCard({ result }: RecommendationCardProps) {
  const eventResult = result.eventResult ?? null;
  const isEventMode = result.planningMode === "event" && eventResult !== null;
  const bestWindow = result.bestWindow;
  const displayRating =
    isEventMode
      ? eventResult!.rating
      : result.summary.messageType === "alert_blocked" ||
          result.summary.messageType === "weather_blocked" ||
          result.summary.messageType === "aqi_blocked" ||
          result.summary.messageType === "temp_blocked"
        ? "Avoid"
        : result.summary.messageType === "time_limited" ||
            result.summary.messageType === "daylight_limited" ||
            result.summary.messageType === "fallback"
          ? "Caution"
          : bestWindow?.rating ?? "Avoid";
  const title = result.summary.heading;
  const timeZone = result.location.timeZone;
  const activityConfig = getActivityConfig(result.activity);
  const secondaryWindow = isEventMode
    ? eventResult.bestAlternateWindow
    : result.secondaryWindow;
  const showSecondaryOption = Boolean(
    !isEventMode &&
      bestWindow &&
      secondaryWindow &&
      secondaryWindow.classification !== "avoid" &&
      !secondaryWindow.hours.some((hour) => hour.activeAlertImpact === "severe") &&
      !secondaryWindow.hours.some((hour) =>
        hour.reasons.some((reason) =>
          [
            "severe storms possible",
            "tornado risk mentioned",
            "heavy rain or flooding risk",
            "ice or freezing rain risk"
          ].includes(reason)
        )
      ) &&
      (secondaryWindow.classification === "good" ||
        secondaryWindow.averageScore >= bestWindow.averageScore + 8)
  );
  const cardToneStyles =
    displayRating === "Good"
      ? "border-emerald-200 bg-gradient-to-br from-emerald-50/80 via-white to-white shadow-lg shadow-emerald-100/60"
      : displayRating === "Caution"
        ? "border-amber-200 bg-gradient-to-br from-amber-50/80 via-white to-white shadow-lg shadow-amber-100/60"
        : "border-rose-200 bg-gradient-to-br from-rose-50/80 via-white to-white shadow-lg shadow-rose-100/60";
  const bannerStyles =
    result.summary.bannerTone === "danger"
      ? "border-coral/20 bg-rose-50 text-coral"
      : result.summary.bannerTone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-slate-200 bg-slate-50 text-slate-700";
  const formatDuration = (startTime: string, endTime: string) => {
    const durationHours = (new Date(endTime).getTime() - new Date(startTime).getTime()) / (60 * 60 * 1000);
    const roundedHours = Math.round(durationHours * 10) / 10;
    return `${roundedHours} ${roundedHours === 1 ? "hour" : "hours"}`;
  };
  const alternateIsLongRange =
    isEventMode &&
    eventResult!.bestAlternateWindow &&
    new Date(eventResult!.bestAlternateWindow.startTime).getTime() - new Date(eventResult!.endTime).getTime() >=
      48 * 60 * 60 * 1000;
  const alternateLabel = alternateIsLongRange
    ? "Later available option (longer-range forecast)"
    : "Better option";
  const shouldShowRiskTrend =
    Boolean(result.summary.riskTrend) &&
    !result.summary.decisionChip &&
    !result.summary.contextNote &&
    result.summary.messageType === "normal" &&
    result.summary.emphasis !== "caution";
  const shouldShowNote =
    Boolean(result.summary.note) &&
    result.summary.note !== result.summary.explanation;
  const averageWindowAqi = (window: typeof bestWindow) => {
    if (!window || !window.hours.length) return null;
    const values = window.hours
      .map((hour) => hour.airQuality?.aqi ?? hour.forecast.aqi ?? null)
      .filter((value): value is number => value !== null);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  const getLocalHour = (iso: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone
      }).format(new Date(iso))
    );

  const getSecondaryWindowLabel = () => {
    if (!showSecondaryOption || !secondaryWindow) return null;

    const startHour = getLocalHour(secondaryWindow.startTime);
    const isEarlyMorning = startHour >= 4 && startHour < 8;
    const selectedIsGoodDaylight = Boolean(
      bestWindow &&
        bestWindow.rating === "Good" &&
        bestWindow.daylightTier === "daylight"
    );
    const isDaylightOption =
      secondaryWindow.daylightTier === "daylight" &&
      activityConfig.daylightPreference !== "night-allowed";
    const hasThunderstormRiskLater = result.hourly.some((hour) => {
      const startMs = new Date(hour.forecast.startTime).getTime();
      return (
        startMs >= new Date(secondaryWindow.endTime).getTime() &&
        hour.reasons.some((reason) =>
          ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(reason)
        )
      );
    });
    const bestWindowAqi = averageWindowAqi(bestWindow);
    const secondaryWindowAqi = averageWindowAqi(secondaryWindow);
    const secondaryHasWorseAqi =
      bestWindowAqi !== null &&
      secondaryWindowAqi !== null &&
      secondaryWindowAqi >= bestWindowAqi + 10;
    const materiallyBetter = bestWindow
      ? secondaryWindow.averageScore >= bestWindow.averageScore + 5 ||
        (bestWindow.classification !== "good" && secondaryWindow.classification === "good")
      : false;
    const materiallyWorse = bestWindow
      ? secondaryWindow.averageScore <= bestWindow.averageScore - 5 || secondaryHasWorseAqi
      : false;

    if (
      isDaylightOption &&
      (selectedDaylightFallback(bestWindow) ||
        !bestWindow ||
        bestWindow.classification !== "good") &&
      materiallyBetter
    ) {
      return {
        prefix: "A better daylight option is",
        suffix: "daylight option"
      };
    }
    if (selectedIsGoodDaylight) {
      if (materiallyWorse) {
        return {
          prefix: "Another workable option:",
          suffix: secondaryHasWorseAqi ? "later good option" : isEarlyMorning ? "early morning" : null
        };
      }
      return {
        prefix: "Another good option:",
        suffix: isEarlyMorning ? "early morning" : null
      };
    }
    if (hasThunderstormRiskLater) {
      return {
        prefix: "Secondary option:",
        suffix: "before thunderstorms return"
      };
    }
    if (isEarlyMorning) {
      return {
        prefix: "Secondary option:",
        suffix: "early morning"
      };
    }

    return {
      prefix: "Secondary option:",
      suffix: null
    };
  };

  const secondaryWindowLabel = getSecondaryWindowLabel();
  const displaySubline = isEventMode
    ? `${formatHourRange(
        eventResult!.startTime,
        eventResult!.endTime,
        timeZone
      )} (${formatDuration(eventResult!.startTime, eventResult!.endTime)})`
    : bestWindow
      ? formatHourRange(
          bestWindow.startTime,
          bestWindow.endTime,
          timeZone
        )
      : result.summary.recommendation === result.summary.heading
        ? null
        : result.summary.recommendation;

  return (
    <section className={`rounded-[2rem] border p-6 shadow-md sm:p-7 ${cardToneStyles}`}>
      {result.summary.banner ? (
        <div
          className={`mb-6 rounded-2xl border px-4 py-3 text-sm font-medium leading-7 ${bannerStyles}`}
        >
          {result.summary.banner}
        </div>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="result-reveal space-y-3">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] ${
              result.summary.emphasis === "caution"
                ? "bg-amber-100 text-amber-800"
                : "bg-sky/80 text-tide"
            }`}
          >
            {isEventMode ? "Planned event" : "Recommendation"}
          </span>
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-[2rem]">{title}</h2>
            {displaySubline ? (
              <p className="mt-2 text-base leading-7 text-slate-600">{displaySubline}</p>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Rating" value={displayRating} />
          <Metric
            label="Confidence"
            value={result.summary.confidence}
            helper={result.summary.confidenceExplanation}
          />
          <Metric label="Location" value={result.location.label} />
        </div>
      </div>

      {result.summary.clearRiskLine ? (
        <div className="mt-5 rounded-2xl bg-slate-100 px-4 py-3 text-sm leading-7 text-slate-700">
          <span className="font-semibold text-ink">When risk may clear:</span>{" "}
          {result.summary.clearRiskLine}
        </div>
      ) : null}

      <div className="result-reveal result-reveal-delay-1">
        <p className="mt-6 max-w-3xl text-sm leading-7 text-slate-700">
          {result.summary.explanation}
        </p>
      </div>

      {result.summary.highlightInsight ? (
        <div className="result-reveal result-reveal-delay-2 mt-4 rounded-2xl bg-mist px-4 py-3 text-sm font-medium leading-7 text-ink">
          {result.summary.highlightInsight}
        </div>
      ) : null}

      {isEventMode ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-2xl bg-mist p-4 text-sm text-slate-700">
            <span className="font-semibold text-ink">Main concern:</span>{" "}
            {eventResult!.mainConcern}
          </div>
          {eventResult!.rating !== "Good" && eventResult!.worstWindow ? (
            <div className="rounded-2xl bg-amber-50 p-4 text-sm text-slate-700">
              <span className="font-semibold text-ink">Worst period:</span>{" "}
              {formatHourRange(
                eventResult!.worstWindow.startTime,
                eventResult!.worstWindow.endTime,
                timeZone
              )}
            </div>
          ) : null}
          {eventResult!.bestAlternateWindow ? (
            <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-slate-700">
              <span className="font-semibold text-ink">{alternateLabel}:</span>{" "}
              {formatHourRange(
                eventResult!.bestAlternateWindow.startTime,
                eventResult!.bestAlternateWindow.endTime,
                timeZone
              )}{" "}
              ({formatDuration(
                eventResult!.bestAlternateWindow.startTime,
                eventResult!.bestAlternateWindow.endTime
              )})
              {eventResult!.bestAlternateReason ? (
                <p className="mt-2 text-xs leading-6 text-slate-600">
                  <span className="font-semibold text-ink">Reason:</span>{" "}
                  {eventResult!.bestAlternateReason}
                </p>
              ) : null}
              {eventResult!.guidanceNote ? (
                <p className="mt-2 text-xs leading-6 text-slate-600">
                  {eventResult!.guidanceNote}
                </p>
              ) : null}
            </div>
          ) : eventResult!.rating !== "Good" ? (
            <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <span className="font-semibold text-ink">Better option:</span>{" "}
              No better alternate window found in the available forecast period.
            </div>
          ) : null}
        </div>
      ) : null}

      {result.summary.decisionChip || result.summary.contextNote || shouldShowRiskTrend ? (
        <div className="mt-4 flex flex-wrap gap-3">
          {result.summary.decisionChip ? (
            <div className="rounded-full bg-mist px-4 py-2 text-sm font-semibold text-ink">
              {result.summary.decisionChip}
            </div>
          ) : null}
          {result.summary.contextNote ? (
            <div className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-700">
              {result.summary.contextNote}
            </div>
          ) : null}
          {shouldShowRiskTrend ? (
            <div className="rounded-full bg-slate-50 px-4 py-2 text-sm text-slate-600">
              {result.summary.riskTrend}
            </div>
          ) : null}
        </div>
      ) : null}

      {shouldShowNote ? (
        <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm leading-7 text-slate-700">
          <span className="font-semibold text-ink">Stay alert:</span> {result.summary.note}
        </div>
      ) : null}

      {!isEventMode ? (
        <div className="mt-6 grid gap-3 lg:grid-cols-3">
        {showSecondaryOption && secondaryWindow ? (
          <div className="rounded-2xl bg-mist p-4 text-sm text-slate-700">
            <span className="font-semibold text-ink">{secondaryWindowLabel?.prefix ?? "Secondary option:"}</span>{" "}
            {formatHourRange(
              secondaryWindow.startTime,
              secondaryWindow.endTime,
              timeZone
            )}
            {secondaryWindowLabel?.suffix ? ` (${secondaryWindowLabel.suffix})` : ""}
          </div>
        ) : null}

        {result.cautionWindows[0] ? (
          <div className="rounded-2xl bg-amber-50 p-4 text-sm text-slate-700">
            <span className="font-semibold text-ink">Use caution:</span>{" "}
            {formatHourRange(
              result.cautionWindows[0].startTime,
              result.cautionWindows[0].endTime,
              timeZone
            )}
          </div>
        ) : null}

        {result.avoidWindows[0] ? (
          <div className="rounded-2xl bg-rose-50 p-4 text-sm text-slate-700">
            <span className="font-semibold text-ink">Avoid this period:</span>{" "}
            {formatHourRange(
              result.avoidWindows[0].startTime,
              result.avoidWindows[0].endTime,
              timeZone
            )}
          </div>
        ) : null}
        </div>
      ) : null}
    </section>
  );
}

function selectedDaylightFallback(
  window: DecisionResponse["bestWindow"] | null
) {
  return Boolean(window?.selectedAsDaylightFallback || window?.daylightTier !== "daylight");
}

function Metric({
  label,
  value,
  helper
}: {
  label: string;
  value: string;
  helper?: string;
}) {
  return (
    <div className="rounded-2xl bg-mist px-4 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
      {helper ? <p className="mt-1 text-xs leading-5 text-slate-600">{helper}</p> : null}
    </div>
  );
}
