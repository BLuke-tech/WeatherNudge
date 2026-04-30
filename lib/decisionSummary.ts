import { detectForecastHazards, getRelevantForecastTextForHour } from "@/lib/forecastHazards";
import {
  getActivityConfig,
  isLateNightWindow
} from "@/lib/activityConfig";
import { getDaylightWindowTier, isMostlyDaylightWindow } from "@/lib/daylight";
import { getSevereRiskSummaryAlerts } from "@/lib/scoring";
import { ActivityMode, DecisionResponse, TimeHorizon } from "@/lib/types";
import { formatClockTime, formatHourRange } from "@/lib/utils";

function normalizeEventName(event: string) {
  return event.trim().toLowerCase();
}

function isAlertActiveNow(alert: DecisionResponse["alerts"][number]) {
  const now = Date.now();
  const onset = alert.onset ? new Date(alert.onset).getTime() : null;
  const ends = alert.ends ? new Date(alert.ends).getTime() : null;

  if (onset && onset > now) return false;
  if (ends && ends < now) return false;
  return true;
}

function getWindowAlerts(
  alerts: DecisionResponse["alerts"],
  startTime: string,
  endTime: string
) {
  const windowStart = new Date(startTime).getTime();
  const windowEnd = new Date(endTime).getTime();

  return alerts.filter((alert) => {
    const onset = alert.onset ? new Date(alert.onset).getTime() : null;
    const ends = alert.ends ? new Date(alert.ends).getTime() : null;

    if (onset && onset > windowEnd) return false;
    if (ends && ends < windowStart) return false;
    return true;
  });
}

function formatFloodRiskChip(
  alerts: DecisionResponse["alerts"],
  bestWindow: DecisionResponse["bestWindow"],
  timeZone: string
) {
  const floodAlerts = alerts.filter((alert) =>
    normalizeEventName(alert.event).includes("flood")
  );

  if (!floodAlerts.length) return null;

  const formatFloodAlert = (alert: DecisionResponse["alerts"][number]) => {
    const normalizedEvent = normalizeEventName(alert.event);
    if (normalizedEvent.includes("watch") && alert.ends) {
      return `${alert.event} until ${formatClockTime(alert.ends, timeZone)}`;
    }
    return `${alert.event} in effect`;
  };

  if (!bestWindow) {
    const activeFloodAlert = floodAlerts.find(isAlertActiveNow) ?? floodAlerts[0];
    return formatFloodAlert(activeFloodAlert);
  }

  const overlapping = getWindowAlerts(
    floodAlerts,
    bestWindow.startTime,
    bestWindow.endTime
  );
  if (overlapping.length) {
    return formatFloodAlert(overlapping[0]);
  }

  const windowStart = new Date(bestWindow.startTime).getTime();
  const earlierFloodAlert = floodAlerts.find((alert) => {
    const ends = alert.ends ? new Date(alert.ends).getTime() : null;
    return ends !== null && ends <= windowStart;
  });

  if (earlierFloodAlert) {
    return "Flood risk earlier";
  }

  return null;
}

function findFirstLaterHazardHour(
  hourly: DecisionResponse["hourly"],
  endTime: string
) {
  const endMs = new Date(endTime).getTime();

  return hourly.find((hour) => {
    const startMs = new Date(hour.forecast.startTime).getTime();
    if (startMs < endMs) return false;

    return hour.reasons.some((reason) =>
      [
        "thunderstorms possible",
        "severe storms possible",
        "tornado risk mentioned",
        "heavy rain or flooding risk",
        "ice or freezing rain risk",
        "snow may affect conditions"
      ].includes(reason)
    );
  });
}

function describeLaterHazard(hour: DecisionResponse["hourly"][number]) {
  if (
    hour.reasons.some((reason) =>
      ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(reason)
    )
  ) {
    return "thunderstorms return";
  }

  if (
    hour.reasons.some((reason) =>
      ["heavy rain or flooding risk", "ice or freezing rain risk", "snow may affect conditions"].includes(reason)
    )
  ) {
    return "hazardous precipitation increases";
  }

  return null;
}

function findEarlierClearingHazard(
  hourly: DecisionResponse["hourly"],
  startTime: string
) {
  const startMs = new Date(startTime).getTime();
  const earlierHazardHour = [...hourly]
    .reverse()
    .find((hour) => {
      const hourStart = new Date(hour.forecast.startTime).getTime();
      return (
        hourStart < startMs &&
        (hour.activeAlertImpact === "severe" ||
          hour.activeAlertImpact === "moderate" ||
          hour.recentAlertImpact === "moderate" ||
          hour.reasons.some((reason) =>
            [
              "thunderstorms possible",
              "severe storms possible",
              "tornado risk mentioned",
              "heavy rain or flooding risk",
              "ice or freezing rain risk",
              "snow may affect conditions"
            ].includes(reason)
          ))
      );
    });

  if (!earlierHazardHour) return null;

  if (
    earlierHazardHour.reasons.some((reason) =>
      ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(reason)
    )
  ) {
    return "thunderstorms";
  }

  if (
    earlierHazardHour.reasons.some((reason) =>
      ["heavy rain or flooding risk", "ice or freezing rain risk", "snow may affect conditions"].includes(reason)
    )
  ) {
    return "hazardous weather";
  }

  if (
    earlierHazardHour.activeAlertImpact === "severe" ||
    earlierHazardHour.activeAlertImpact === "moderate" ||
    earlierHazardHour.recentAlertImpact === "moderate"
  ) {
    return "earlier severe weather";
  }

  return null;
}

function formatClearingHazardInsight(hazardLabel: string) {
  if (hazardLabel === "thunderstorms") {
    return "Conditions improve after thunderstorms clear earlier.";
  }

  if (hazardLabel === "hazardous weather") {
    return "Conditions improve after hazardous weather clears earlier.";
  }

  return `Conditions improve after ${hazardLabel} clears earlier.`;
}

function getAqiCategoryLabel(aqi: number | null | undefined) {
  if (aqi === null || aqi === undefined) return null;
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

export function buildSummary(
  response: Pick<
    DecisionResponse,
    "bestWindow" | "alerts" | "airQuality" | "hourly" | "nextAvailableWindow"
  >,
  horizon: TimeHorizon,
  timeZone: string,
  activity: ActivityMode,
  options?: {
    todayNearlyOver?: boolean;
    latitude?: number | null;
    longitude?: number | null;
  }
) {
  const activityConfig = getActivityConfig(activity);
  const todayNearlyOver = options?.todayNearlyOver ?? false;
  const warningBannerEvents = new Set([
    "tornado warning",
    "severe thunderstorm warning",
    "flash flood warning",
    "extreme wind warning"
  ]);
  const severeRiskAlerts = getSevereRiskSummaryAlerts(response.alerts);
  const activeSevereRiskAlerts = severeRiskAlerts.filter(isAlertActiveNow);
  const hasSevereAlertsInHorizon = response.hourly.some(
    (hour) => hour.activeAlertImpact === "severe"
  );
  const bestWindowHours = response.bestWindow?.hours ?? [];
  const selectedDaylightFallback = response.bestWindow?.selectedAsDaylightFallback ?? false;
  const recommendedWindowUsesBuffer = bestWindowHours.some(
    (hour) => hour.recentAlertImpact === "moderate"
  );
  const recommendedWindowHasActiveWarning = bestWindowHours.some(
    (hour) => hour.activeAlertImpact === "severe"
  );
  const recommendedWindowHasActiveWatch = bestWindowHours.some(
    (hour) => hour.activeAlertImpact === "moderate"
  );
  const severeWeatherEarlierInHorizon =
    !recommendedWindowUsesBuffer &&
    !recommendedWindowHasActiveWarning &&
    !recommendedWindowHasActiveWatch &&
    Boolean(
      response.bestWindow &&
        response.hourly.some((hour) => {
          const hourStart = new Date(hour.forecast.startTime).getTime();
          const bestWindowStart = new Date(response.bestWindow!.startTime).getTime();
          return (
            hourStart < bestWindowStart &&
            (hour.activeAlertImpact === "severe" ||
              hour.activeAlertImpact === "moderate" ||
              hour.recentAlertImpact === "moderate")
          );
        })
    );
  const activeAlertsOverlappingRecommendedWindow = response.bestWindow
    ? getWindowAlerts(
        activeSevereRiskAlerts,
        response.bestWindow.startTime,
        response.bestWindow.endTime
      )
    : [];
  const hasActiveOverlap = activeAlertsOverlappingRecommendedWindow.length > 0;
  const hasActiveWarningOverlap = activeAlertsOverlappingRecommendedWindow.some((alert) =>
    warningBannerEvents.has(normalizeEventName(alert.event))
  );
  const hasActiveButNotOverlap = activeSevereRiskAlerts.length > 0 && !hasActiveOverlap;
  const hasRecentOnly =
    !activeSevereRiskAlerts.length &&
    (recommendedWindowUsesBuffer || severeWeatherEarlierInHorizon);
  const floodRiskChip = formatFloodRiskChip(
    response.alerts,
    response.bestWindow,
    timeZone
  );
  const lateNightBestWindow = Boolean(
    response.bestWindow &&
      isLateNightWindow(response.bestWindow.startTime, response.bestWindow.endTime, timeZone)
  );
  const nonDaylightBestWindow = Boolean(
    response.bestWindow &&
      !isMostlyDaylightWindow(
        response.bestWindow.startTime,
        response.bestWindow.endTime,
        options?.latitude,
        options?.longitude,
        timeZone
      )
  );
  const daylightTier = response.bestWindow
    ? getDaylightWindowTier(
        response.bestWindow.startTime,
        response.bestWindow.endTime,
        options?.latitude,
        options?.longitude,
        timeZone
      )
    : null;
  const hazardReasonsInHorizon = response.hourly.flatMap((hour) =>
    hour.reasons.filter((reason) =>
      [
        "thunderstorms possible",
        "severe storms possible",
        "tornado risk mentioned",
        "heavy rain or flooding risk",
        "ice or freezing rain risk",
        "snow may affect conditions",
        "fog may reduce visibility",
        "smoke may affect air quality",
        "dangerous heat risk",
        "dangerous cold risk"
      ].includes(reason)
    )
  );
  const hasStormRisk =
    hazardReasonsInHorizon.some((reason) =>
      ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(
        reason
      )
    ) || activeSevereRiskAlerts.some((alert) => normalizeEventName(alert.event).includes("watch"));
  const hasFloodRisk =
    Boolean(floodRiskChip) ||
    hazardReasonsInHorizon.includes("heavy rain or flooding risk");
  const daylightHours = response.hourly.filter((hour) =>
    getDaylightWindowTier(
      hour.forecast.startTime,
      hour.forecast.endTime,
      options?.latitude,
      options?.longitude,
      timeZone,
      { fallbackIsDaytime: hour.forecast.isDaytime }
    ) === "daylight"
  );
  const usableDaylightHours = daylightHours.filter(
    (hour) => hour.classification === "good" || hour.classification === "caution"
  );
  const goodDaylightHours = daylightHours.filter(
    (hour) => hour.classification === "good"
  );
  const laterForecastRisk = Boolean(
    response.bestWindow &&
      response.hourly.some((hour) => {
        const afterWindow =
          new Date(hour.forecast.startTime).getTime() >=
          new Date(response.bestWindow!.endTime).getTime();
        if (!afterWindow) return false;

        const relevantDetailedText = getRelevantForecastTextForHour(
          hour.forecast,
          hour.forecast.detailedForecast ?? "",
          timeZone
        );
        const hazardText = [hour.forecast.shortForecast, relevantDetailedText]
          .filter(Boolean)
          .join(" ");
        const kinds = detectForecastHazards(hazardText).map((hazard) => hazard.kind);

        return kinds.some((kind) =>
          ["thunderstorms", "severe-storms", "tornado", "flooding"].includes(kind)
        );
      })
  );
  const latestRiskAlertEnd = activeSevereRiskAlerts
    .map((alert) => alert.ends)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const clearRiskLineRelevant = Boolean(
    activeSevereRiskAlerts.length &&
      (!response.bestWindow || hasActiveOverlap || hasActiveButNotOverlap)
  );
  const baseClearRiskLine = clearRiskLineRelevant
    ? latestRiskAlertEnd
      ? `Severe weather risk remains active through ${formatClockTime(latestRiskAlertEnd, timeZone)}.`
      : "Severe weather is active. Check official alerts before heading out."
    : undefined;
  const bannerConfig = (() => {
    if (!response.bestWindow) {
      if (activeSevereRiskAlerts.length) {
        return {
          banner:
            "Severe weather is active in this area. Outdoor plans are not recommended until conditions clearly improve.",
          bannerTone: "danger" as const
        };
      }

      if (hasRecentOnly) {
        return {
          banner: "Recent severe weather may still affect near-term conditions.",
          bannerTone: "info" as const
        };
      }

      return {
        banner: undefined,
        bannerTone: undefined
      };
    }

    if (hasActiveWarningOverlap) {
      return {
        banner: "Outdoor plans are not recommended during this time.",
        bannerTone: "danger" as const
      };
    }

    if (hasActiveButNotOverlap) {
      return {
        banner: "Severe weather is active earlier. Conditions improve later.",
        bannerTone: "warning" as const
      };
    }

    if (recommendedWindowUsesBuffer || hasRecentOnly) {
      return {
        banner: "Recent severe weather may still affect nearby timing.",
        bannerTone: "info" as const
      };
    }

    return {
      banner: undefined,
      bannerTone: undefined
    };
  })();

  const hazardPriorityReasons = [
    "tornado risk mentioned",
    "severe storms possible",
    "thunderstorms possible",
    "heavy rain or flooding risk",
    "ice or freezing rain risk",
    "snow may affect conditions",
    "fog may reduce visibility",
    "smoke may affect air quality",
    "dangerous heat risk",
    "dangerous cold risk"
  ];
  const selectedWindowReasons = bestWindowHours.flatMap((hour) => hour.reasons);
  const stormContextNote = hasActiveButNotOverlap
    ? "Severe weather is active earlier."
    : severeWeatherEarlierInHorizon
      ? horizon === "tonight"
        ? "Thunderstorm risk earlier tonight."
        : "Severe weather earlier in the horizon."
      : laterForecastRisk
        ? "Thunderstorms may return later."
        : undefined;
  const broadContextNote =
    floodRiskChip ??
    stormContextNote ??
    (activeSevereRiskAlerts.length && !response.bestWindow
      ? "Severe weather is active in this area."
      : undefined);

  const pickMainFactor = () => {
    const relevantHours = response.bestWindow?.hours ?? response.hourly;
    const reasons = relevantHours.flatMap((hour) => hour.reasons);
    const hasLimitingFactor = relevantHours.some((hour) => {
      const apparentTemperature = hour.forecast.apparentTemperatureF ?? hour.forecast.temperatureF;
      return (
        hour.activeAlertImpact !== "none" ||
        hour.recentAlertImpact === "moderate" ||
        hour.forecast.precipitationChance !== null && hour.forecast.precipitationChance >= 40 ||
        hour.forecast.visibilityMiles !== null && hour.forecast.visibilityMiles < 5 ||
        hour.forecast.windGustMph !== null && hour.forecast.windGustMph >= 30 ||
        apparentTemperature !== null && (apparentTemperature < 45 || apparentTemperature > 88) ||
        hour.forecast.dewpointF !== null && hour.forecast.dewpointF >= 70 ||
        hour.forecast.fogMentioned ||
        hour.forecast.smokeMentioned
      );
    });

    if (!response.bestWindow && horizon === "tonight" && activityConfig.daylightPreference === "required") {
      return "no usable daylight window";
    }

    if (selectedDaylightFallback) {
      return hasStormRisk || laterForecastRisk
        ? "limited daylight window before storm risk returns"
        : "no ideal daylight window found";
    }

    if (recommendedWindowUsesBuffer) return "recent severe weather nearby";
    if (recommendedWindowHasActiveWarning) return "active severe alert";

    if (recommendedWindowHasActiveWatch) return "active severe watch";

    const hazardReason = hazardPriorityReasons.find((reason) => reasons.includes(reason));
    if (hazardReason) return hazardReason;

    if (!response.bestWindow) {
      const hasHazardousPrecipitation = reasons.some((reason) =>
        [
          "heavy rain or flooding risk",
          "ice or freezing rain risk",
          "snow may affect conditions",
          "thunderstorms possible",
          "severe storms possible",
          "tornado risk mentioned"
        ].includes(reason)
      );
      const hasColdConditions = relevantHours.some((hour) => {
        const feelsLike = hour.forecast.apparentTemperatureF ?? hour.forecast.temperatureF;
        return feelsLike !== null && feelsLike <= 34;
      });

      if (hasHazardousPrecipitation && hasColdConditions) {
        return "storm/snow risk and cold conditions";
      }

      if (hasHazardousPrecipitation) {
        return "hazardous precipitation";
      }
    }

    const apparentTemperatureReason =
      reasons.find((reason) => reason.startsWith("feels like ")) ?? null;
    if (apparentTemperatureReason) return apparentTemperatureReason;

    const gustReason =
      reasons.find((reason) => reason.startsWith("dangerous wind gusts near ")) ??
      reasons.find((reason) => reason.startsWith("gusty winds near ")) ??
      reasons.find((reason) => reason.startsWith("wind picks up near "));
    if (gustReason) return gustReason;

    const visibilityReason =
      reasons.find((reason) => reason.startsWith("reduced visibility around "));
    if (visibilityReason) return visibilityReason;

    const rainReason =
      reasons.find((reason) =>
        ["very high precip chance", "high precip chance", "precip likely limits outdoor plans"].includes(
          reason
        )
      ) ?? null;
    if (rainReason) return rainReason;

    const laterHours = response.bestWindow
      ? response.hourly.filter(
          (hour) =>
            new Date(hour.forecast.startTime).getTime() >=
            new Date(response.bestWindow!.endTime).getTime()
        )
      : [];
    const bestWindowAqiValues = response.bestWindow
      ? response.bestWindow.hours
          .map((hour) => hour.airQuality?.aqi ?? hour.forecast.aqi ?? null)
          .filter((value): value is number => value !== null)
      : [];
    const laterAqiValues = laterHours
      .map((hour) => hour.airQuality?.aqi ?? hour.forecast.aqi ?? null)
      .filter((value): value is number => value !== null);
    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    if (
      response.bestWindow &&
      bestWindowAqiValues.length &&
      laterAqiValues.length &&
      average(laterAqiValues) >= average(bestWindowAqiValues) + 15 &&
      Math.max(...laterAqiValues) >= 60
    ) {
      return "AQI stays lower during this window";
    }

    const humidityReason =
      reasons.find((reason) => reason === "oppressive humidity") ??
      reasons.find((reason) => reason === "humid air may make it feel worse");
    if (humidityReason) return humidityReason;

    if (reasons.includes("low precip risk")) return "low precipitation risk";

    const aqiReason = reasons.find(
      (reason) => reason.startsWith("AQI ") || reason.includes("air quality")
    );
    if (aqiReason) return aqiReason;

    const comfortReason = !hasLimitingFactor
      ? reasons.find((reason) => reason.startsWith("comfortable around "))
      : undefined;
    if (comfortReason) return "comfortable conditions";

    if (!response.bestWindow) return "rain, wind, or timing limits this timeframe";
    if (response.bestWindow.reasons.some((reason) => reason.startsWith("lighter wind near"))) {
      return "lighter wind";
    }
    return response.bestWindow.reasons[0] ?? "balanced weather conditions";
  };

  const mainFactor = (() => {
    return pickMainFactor();
  })();
  const clearRiskLine = todayNearlyOver ? undefined : baseClearRiskLine;
  const riskTrend: DecisionResponse["summary"]["riskTrend"] = (() => {
    if (
      todayNearlyOver ||
      floodRiskChip ||
      recommendedWindowHasActiveWatch ||
      hasStormRisk ||
      recommendedWindowHasActiveWarning ||
      recommendedWindowUsesBuffer ||
      severeWeatherEarlierInHorizon ||
      laterForecastRisk ||
      hasActiveButNotOverlap
    ) {
      return undefined;
    }

    const firstHalf = response.hourly.slice(0, Math.ceil(response.hourly.length / 2));
    const secondHalf = response.hourly.slice(Math.ceil(response.hourly.length / 2));
    const average = (hours: typeof response.hourly) =>
      hours.length
        ? hours.reduce((sum, hour) => sum + hour.score, 0) / hours.length
        : 0;
    const firstHalfAverage = average(firstHalf);
    const secondHalfAverage = average(secondHalf);
    const trendDelta = secondHalfAverage - firstHalfAverage;

    return trendDelta >= 8
      ? activeSevereRiskAlerts.length
        ? "Conditions improving, but stay alert"
        : "Conditions improving"
      : trendDelta <= -8
        ? "Conditions worsening"
        : "Conditions stable";
  })();
  const highlightInsight = (() => {
    if (!response.bestWindow) return undefined;

    const laterHazardHour = findFirstLaterHazardHour(response.hourly, response.bestWindow.endTime);
    const laterHazardLabel = laterHazardHour ? describeLaterHazard(laterHazardHour) : null;
    if (laterHazardHour && laterHazardLabel) {
      return `Best window ends before ${laterHazardLabel} around ${formatClockTime(
        laterHazardHour.forecast.startTime,
        timeZone
      )}.`;
    }

    const earlierHazardLabel =
      severeWeatherEarlierInHorizon || hasRecentOnly
        ? findEarlierClearingHazard(response.hourly, response.bestWindow.startTime)
        : null;
    if (earlierHazardLabel) {
      return formatClearingHazardInsight(earlierHazardLabel);
    }

    const laterHours = response.hourly.filter(
      (hour) =>
        new Date(hour.forecast.startTime).getTime() >= new Date(response.bestWindow!.endTime).getTime()
    );
    if (!laterHours.length || !bestWindowHours.length) return undefined;

    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const bestWindowAqiValues = bestWindowHours
      .map((hour) => hour.airQuality?.aqi ?? hour.forecast.aqi ?? null)
      .filter((value): value is number => value !== null);
    const laterAqiValues = laterHours
      .map((hour) => hour.airQuality?.aqi ?? hour.forecast.aqi ?? null)
      .filter((value): value is number => value !== null);
    const bestWindowAqiAverage = bestWindowAqiValues.length ? average(bestWindowAqiValues) : null;
    const laterAqiAverage = laterAqiValues.length ? average(laterAqiValues) : null;
    const laterPeakAqi = laterAqiValues.length ? Math.max(...laterAqiValues) : null;

    if (
      bestWindowAqiAverage !== null &&
      laterAqiAverage !== null &&
      laterPeakAqi !== null &&
      laterAqiAverage >= bestWindowAqiAverage + 15 &&
      laterPeakAqi >= 60
    ) {
      const laterCategory = getAqiCategoryLabel(laterPeakAqi);
      if (laterPeakAqi >= 101 && laterCategory) {
        return `Best conditions occur before AQI reaches ${laterCategory}.`;
      }

      return "Best window ends before air quality worsens later.";
    }

    const bestWindowFeelsLike = average(
      bestWindowHours.map((hour) => hour.forecast.apparentTemperatureF ?? hour.forecast.temperatureF ?? 0)
    );
    const laterFeelsLike = average(
      laterHours.map((hour) => hour.forecast.apparentTemperatureF ?? hour.forecast.temperatureF ?? 0)
    );
    const bestWindowWind = average(
      bestWindowHours.map((hour) => hour.forecast.windGustMph ?? hour.forecast.windSpeedMph ?? 0)
    );
    const laterWind = average(
      laterHours.map((hour) => hour.forecast.windGustMph ?? hour.forecast.windSpeedMph ?? 0)
    );

    if (laterFeelsLike >= bestWindowFeelsLike + 8 && laterWind >= bestWindowWind + 6) {
      return "Best conditions occur before temperatures and winds increase.";
    }
    if (laterFeelsLike >= bestWindowFeelsLike + 8) {
      return "Best conditions occur before temperatures increase.";
    }
    if (laterWind >= bestWindowWind + 6) {
      return "Best conditions occur before winds increase.";
    }

    return undefined;
  })();
  const activeWarningContextNote = response.alerts.some(
    (alert) =>
      warningBannerEvents.has(normalizeEventName(alert.event)) && isAlertActiveNow(alert)
  )
    || response.hourly.some((hour) => hour.activeAlertImpact === "severe")
    ? "Active warning in effect. Follow official instructions."
    : undefined;
  const hasWeatherBlockingHazard = response.hourly.some((hour) =>
    hour.reasons.some((reason) =>
      [
        "thunderstorms possible",
        "severe storms possible",
        "tornado risk mentioned",
        "heavy rain or flooding risk",
        "ice or freezing rain risk",
        "snow may affect conditions"
      ].includes(reason)
    )
  );
  const hasAqiBlockingHazard = response.hourly.some((hour) =>
    hour.reasons.some((reason) =>
      ["air quality may affect sensitive groups", "unhealthy air quality"].includes(reason)
    )
  );
  const hasTempBlockingHazard = response.hourly.some((hour) =>
    hour.reasons.some((reason) =>
      ["dangerous heat risk", "dangerous cold risk"].includes(reason)
    )
  );
  const hasActiveAlertBlocker =
    recommendedWindowHasActiveWarning ||
    recommendedWindowHasActiveWatch ||
    response.hourly.some((hour) => hour.activeAlertImpact !== "none");
  const finalRating: "Good" | "Caution" | "Avoid" | null = response.bestWindow
    ? selectedDaylightFallback ||
      recommendedWindowUsesBuffer ||
      recommendedWindowHasActiveWarning ||
      recommendedWindowHasActiveWatch
      ? "Caution"
      : response.bestWindow.rating
    : null;
  const messageType: DecisionResponse["summary"]["messageType"] = (() => {
    if (todayNearlyOver && !hasActiveAlertBlocker && !hasWeatherBlockingHazard) {
      return "time_limited";
    }
    if (hasActiveAlertBlocker && (!response.bestWindow || finalRating !== "Good")) {
      return "alert_blocked";
    }
    if (!response.bestWindow && hasWeatherBlockingHazard) {
      return "weather_blocked";
    }
    if (!response.bestWindow && hasAqiBlockingHazard) {
      return "aqi_blocked";
    }
    if (!response.bestWindow && hasTempBlockingHazard) {
      return "temp_blocked";
    }
    if (!response.bestWindow && horizon === "tonight" && activityConfig.daylightPreference === "required") {
      return "daylight_limited";
    }
    if (finalRating === "Caution") {
      return "fallback";
    }
    return "normal";
  })();
  const confidenceExplanation = (() => {
    if (messageType === "time_limited") {
      return "This timeframe is narrow or nearly over, so timing is less reliable.";
    }
    if (messageType === "alert_blocked") {
      return "Active warnings or watches are affecting this period. Follow official alerts.";
    }
    if (messageType === "weather_blocked") {
      return "Storms or heavy precipitation are limiting this window.";
    }
    if (messageType === "daylight_limited") {
      return "No usable daylight window remains for this activity.";
    }
    if (messageType === "aqi_blocked") {
      return "Air quality is the main limiting factor for this period.";
    }
    if (messageType === "temp_blocked") {
      return "Extreme temperatures are the main limiting factor.";
    }
    if (
      recommendedWindowHasActiveWarning ||
      recommendedWindowHasActiveWatch ||
      recommendedWindowUsesBuffer
    ) {
      return "Active or recent severe weather can change quickly.";
    }
    if (severeWeatherEarlierInHorizon) {
      return "Earlier severe weather may shift timing, but this window starts after that risk fades.";
    }
    if (
      response.hourly.some((hour) => hour.classification === "caution") ||
      response.alerts.length > 0
    ) {
      return "Some risk factors are present, but timing is fairly clear.";
    }
    return "Few weather risks are present in this time range.";
  })();
  const decisionChip = (() => {
    if (messageType === "time_limited") return "Today nearly over";
    if (messageType === "daylight_limited") return "No daylight window";
    if (messageType === "fallback") {
      if (selectedDaylightFallback) return "Fallback window";
      if (activityConfig.daylightPreference === "night-allowed" && lateNightBestWindow) {
        return "Late-night option";
      }
      return "Best available";
    }
    if (messageType === "normal") {
      if (activityConfig.daylightPreference === "night-allowed" && lateNightBestWindow) {
        return "Late-night option";
      }
      if (severeWeatherEarlierInHorizon && response.bestWindow?.rating === "Good") {
        return "Good after thunderstorms";
      }
    }
    return undefined;
  })();
  const recommendationLabel = response.bestWindow
    ? `Recommended window: ${formatHourRange(
        response.bestWindow.startTime,
        response.bestWindow.endTime,
        timeZone
      )}`
    : messageType === "time_limited"
      ? "Today is nearly over"
      : messageType === "daylight_limited"
        ? "No good daylight window tonight"
        : "Recommended window unavailable in the selected timeframe.";

  if (!response.bestWindow) {
    return {
      recommendation: recommendationLabel,
      heading:
        messageType === "time_limited"
          ? "Today is nearly over"
          : messageType === "daylight_limited"
            ? "No good daylight window tonight"
            : messageType === "alert_blocked"
              ? "Outdoor conditions are not safe due to active warnings"
              : messageType === "aqi_blocked"
                ? "Outdoor conditions are limited by air quality"
                : messageType === "temp_blocked"
                  ? "Conditions are too extreme for outdoor activity"
                  : "No safe outdoor window due to weather",
      confidence: "Low" as const,
      confidenceExplanation,
      explanation:
        messageType === "time_limited"
          ? "Not enough time left today for a reliable window. Try Tonight or Next 24 hours."
          : messageType === "daylight_limited"
            ? "Try Next 24 hours."
            : messageType === "alert_blocked"
              ? "Outdoor plans are not recommended during this period."
              : messageType === "aqi_blocked"
                ? "Air quality stays unhealthy through this period."
                : messageType === "temp_blocked"
                  ? "Temperatures stay too extreme through this period."
                  : "Storm risk continues through this period.",
      messageType,
      note: undefined,
      highlightInsight:
        messageType === "daylight_limited" && response.nextAvailableWindow
          ? `A better daylight option opens ${formatHourRange(
              response.nextAvailableWindow.startTime,
              response.nextAvailableWindow.endTime,
              timeZone
            )}.`
          : undefined,
      banner: bannerConfig.banner,
      bannerTone: bannerConfig.bannerTone,
      emphasis: "caution" as const,
      clearRiskLine,
      decisionChip,
      contextNote:
        messageType === "time_limited"
          ? activeWarningContextNote
          : messageType === "daylight_limited"
            ? activeWarningContextNote ??
              (hasStormRisk
                ? "Storm risk continues tonight."
                : response.nextAvailableWindow
                  ? "Weather improves during daylight later."
                  : undefined)
            : messageType === "alert_blocked"
              ? activeWarningContextNote
              : messageType === "weather_blocked"
                ? activeWarningContextNote ?? floodRiskChip ?? undefined
                : undefined,
      riskTrend: undefined,
      mainFactor:
        messageType === "time_limited"
          ? "limited remaining time today"
          : messageType === "daylight_limited"
            ? "no usable daylight window"
            : messageType === "alert_blocked"
              ? "active weather warnings"
              : messageType === "aqi_blocked"
                ? "unhealthy air quality"
                : messageType === "temp_blocked"
                  ? "extreme temperatures limit outdoor plans"
                  : "storms or heavy precipitation limit outdoor plans"
    };
  }

  let confidence: "High" | "Medium" | "Low" =
    response.bestWindow.averageScore >= 85
      ? "High"
      : response.bestWindow.averageScore >= 70
        ? "Medium"
        : "Low";

  if (
    recommendedWindowHasActiveWarning ||
    recommendedWindowHasActiveWatch ||
    recommendedWindowUsesBuffer
  ) {
    confidence = "Low";
  } else if (severeWeatherEarlierInHorizon && confidence === "High") {
    confidence = "Medium";
  } else if (response.hourly.some((hour) => hour.classification === "caution")) {
    confidence = "Medium";
  }

  const airNote = response.airQuality.available
    ? "air quality"
    : "weather conditions";
  const heading =
    messageType === "fallback"
      ? "Best available window"
      : "Recommended window";
  const contextNote =
    activeWarningContextNote ??
    floodRiskChip ??
    (messageType === "daylight_limited"
      ? hasStormRisk
        ? "Storm risk continues tonight."
        : response.nextAvailableWindow
          ? "Weather improves during daylight later."
          : undefined
      : hasActiveButNotOverlap
        ? "Severe weather is active earlier."
        : severeWeatherEarlierInHorizon
          ? horizon === "tonight"
            ? "Thunderstorm risk earlier tonight."
            : "Severe weather earlier in the horizon."
          : laterForecastRisk
            ? "Thunderstorms may return later."
            : broadContextNote ?? undefined);

  return {
    recommendation: recommendationLabel,
    heading,
    confidence: messageType === "fallback" ? "Low" : confidence,
    confidenceExplanation,
    explanation:
      messageType === "fallback"
        ? "Conditions are not ideal, but this is the most workable time."
        : severeWeatherEarlierInHorizon
          ? "Conditions improve after the earlier severe weather risk fades."
          : response.bestWindow.reasons.includes("thunderstorms possible")
            ? "This is the best available window, but thunderstorms are possible."
            : `Other green hours may still be available, but this stretch has the best balance of comfort, precipitation risk, and safety using the best available ${airNote}.`,
    messageType,
    highlightInsight,
    banner: bannerConfig.banner,
    bannerTone: bannerConfig.bannerTone,
    emphasis: messageType === "fallback" ? "caution" as const : "normal" as const,
    clearRiskLine,
    decisionChip,
    contextNote,
    riskTrend: messageType === "normal" ? riskTrend : undefined,
    mainFactor: messageType === "fallback" ? "limited but usable conditions" : mainFactor,
    note:
      messageType === "fallback" && selectedDaylightFallback
        ? "This activity usually requires daylight."
        : messageType === "normal" && activityConfig.daylightPreference === "required" && nonDaylightBestWindow
          ? "This activity usually requires daylight."
          : messageType === "normal" && activityConfig.daylightPreference === "preferred" &&
                (daylightTier === "night" || lateNightBestWindow)
            ? "This activity is typically better during daylight."
            : undefined
  };
}
