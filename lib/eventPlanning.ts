import { classifyScore, deriveWindowRating, mergeHoursIntoWindows } from "@/lib/timeWindows";
import {
  DecisionResponse,
  EventAnalysis,
  ScoredHour,
  TimeWindow,
  WeatherAlert
} from "@/lib/types";
import {
  formatDateInputValue,
  formatHourRange,
  formatZonedTime,
  getZonedHour,
  zonedDateTimeToIso
} from "@/lib/utils";
import {
  getActivityConfig,
  isLateNightWindow
} from "@/lib/activityConfig";
import { isDaylightHour, isMostlyDaylightWindow } from "@/lib/daylight";

const severeEventReasons = new Set([
  "severe storms possible",
  "tornado risk mentioned",
  "heavy rain or flooding risk",
  "ice or freezing rain risk",
  "dangerous heat risk",
  "dangerous cold risk"
]);

const floodAlertEvents = new Set([
  "flood watch",
  "flood warning",
  "flood advisory",
  "flash flood warning"
]);

function overlapMs(hour: ScoredHour, startMs: number, endMs: number) {
  const hourStart = new Date(hour.forecast.startTime).getTime();
  const hourEnd = new Date(hour.forecast.endTime).getTime();
  return Math.max(0, Math.min(hourEnd, endMs) - Math.max(hourStart, startMs));
}

function summarizeReasons(hours: ScoredHour[]) {
  const counts = new Map<string, number>();
  const hazardReasons = new Set([
    "active severe weather alert",
    "Active tornado warning",
    "Active tornado watch",
    "Severe thunderstorm warning in effect",
    "Severe thunderstorm watch in effect",
    "Flash flood warning in effect",
    "Extreme wind warning in effect",
    "Flood watch in effect",
    "Flood warning in effect",
    "Flood advisory in effect",
    "thunderstorms possible",
    "severe storms possible",
    "tornado risk mentioned",
    "heavy rain or flooding risk",
    "ice or freezing rain risk",
    "snow may affect conditions",
    "fog may reduce visibility",
    "reduced visibility",
    "dangerous heat risk",
    "dangerous cold risk",
    "gusty winds"
  ]);

  for (const hour of hours) {
    for (const reason of hour.reasons) {
      if (reason === "high precip chance" && counts.has("very high precip chance")) {
        continue;
      }
      if (reason === "very high precip chance") {
        counts.delete("high precip chance");
      }
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  const allReasons = [...counts.keys()];
  const hasHazards = allReasons.some(
    (reason) =>
      hazardReasons.has(reason) ||
      reason.startsWith("reduced visibility") ||
      reason.startsWith("gusty winds near") ||
      reason.includes("warning") ||
      reason.includes("watch")
  );

  const filteredReasons = allReasons.filter((reason) => {
    if (hasHazards && reason.startsWith("comfortable around")) {
      return false;
    }
    return true;
  });

  const priority = (reason: string) => {
    if (
      reason === "active severe weather alert" ||
      reason.includes("warning") ||
      reason.includes("watch")
    ) {
      return 0;
    }
    if (
      [
        "thunderstorms possible",
        "severe storms possible",
        "tornado risk mentioned",
        "heavy rain or flooding risk",
        "ice or freezing rain risk",
        "snow may affect conditions",
        "fog may reduce visibility",
        "dangerous heat risk",
        "dangerous cold risk"
      ].includes(reason) ||
      reason.startsWith("reduced visibility")
    ) {
      return 1;
    }
    if (
      reason === "very high precip chance" ||
      reason === "high precip chance" ||
      reason.includes("% ")
    ) {
      return 2;
    }
    return 3;
  };

  return filteredReasons
    .map((reason) => [reason, counts.get(reason) ?? 0] as const)
    .sort((a, b) => {
      const priorityDelta = priority(a[0]) - priority(b[0]);
      if (priorityDelta !== 0) return priorityDelta;
      return b[1] - a[1];
    })
    .slice(0, 3)
    .map(([reason]) => reason);
}

function normalizeAlertEvent(event: string) {
  return event.trim().toLowerCase();
}

function isAlertOverlap(
  alert: WeatherAlert,
  startMs: number,
  endMs: number
) {
  const onsetMs = alert.onset ? new Date(alert.onset).getTime() : null;
  const endTimeMs = alert.ends ? new Date(alert.ends).getTime() : null;

  if (onsetMs !== null && onsetMs >= endMs) return false;
  if (endTimeMs !== null && endTimeMs <= startMs) return false;
  return true;
}

function formatFloodAlertContext(
  alerts: WeatherAlert[],
  startTime: string,
  endTime: string,
  timeZone: string
) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const floodAlerts = alerts.filter((alert) =>
    floodAlertEvents.has(normalizeAlertEvent(alert.event))
  );

  if (!floodAlerts.length) return null;

  const overlappingAlert = floodAlerts.find((alert) =>
    isAlertOverlap(alert, startMs, endMs)
  );

  if (overlappingAlert) {
    const event = normalizeAlertEvent(overlappingAlert.event);
    if (event === "flood watch" && overlappingAlert.ends) {
      return `Flood Watch until ${formatZonedTime(overlappingAlert.ends, timeZone)}`;
    }

    if (event === "flood advisory") {
      return "Flood Advisory in effect";
    }

    if (event === "flash flood warning") {
      return "Flash Flood Warning in effect";
    }

    return "Flood Warning in effect";
  }

  const earlierAlert = floodAlerts.find((alert) => {
    if (!alert.ends) return false;
    return new Date(alert.ends).getTime() <= startMs;
  });

  if (earlierAlert) {
    return "Flood risk earlier";
  }

  return null;
}

function buildAlternateReason(original: EventAnalysis, alternate: EventAnalysis) {
  const reasons: string[] = [];
  const originalHasHazards = original.overlappingHours.some((hour) =>
    hour.reasons.some((reason) => severeEventReasons.has(reason) || reason === "thunderstorms possible")
  );
  const alternateHasHazards = alternate.overlappingHours.some((hour) =>
    hour.reasons.some((reason) => severeEventReasons.has(reason) || reason === "thunderstorms possible")
  );
  const originalHasAlerts = original.overlappingHours.some((hour) => hour.activeAlertImpact !== "none");
  const alternateHasAlerts = alternate.overlappingHours.some((hour) => hour.activeAlertImpact !== "none");
  const originalAverageWind =
    original.overlappingHours.reduce(
      (sum, hour) => sum + (hour.forecast.windGustMph ?? hour.forecast.windSpeedMph ?? 0),
      0
    ) / original.overlappingHours.length;
  const alternateAverageWind =
    alternate.overlappingHours.reduce(
      (sum, hour) => sum + (hour.forecast.windGustMph ?? hour.forecast.windSpeedMph ?? 0),
      0
    ) / alternate.overlappingHours.length;
  const originalAverageComfort =
    original.overlappingHours.reduce((sum, hour) => sum + hour.breakdown.comfort, 0) /
    original.overlappingHours.length;
  const alternateAverageComfort =
    alternate.overlappingHours.reduce((sum, hour) => sum + hour.breakdown.comfort, 0) /
    alternate.overlappingHours.length;
  const originalAveragePrecip =
    original.overlappingHours.reduce((sum, hour) => sum + (hour.forecast.precipitationChance ?? 0), 0) /
    original.overlappingHours.length;
  const alternateAveragePrecip =
    alternate.overlappingHours.reduce((sum, hour) => sum + (hour.forecast.precipitationChance ?? 0), 0) /
    alternate.overlappingHours.length;

  if (originalHasHazards && !alternateHasHazards) {
    reasons.push("no thunderstorms or hazardous precipitation");
  }
  if (originalHasAlerts && !alternateHasAlerts) {
    reasons.push("no active alerts");
  }
  if (alternateAveragePrecip + 10 <= originalAveragePrecip) {
    reasons.push("lower precipitation risk");
  }
  if (alternateAverageWind + 5 <= originalAverageWind) {
    reasons.push("lower wind");
  }
  if (alternateAverageComfort >= originalAverageComfort + 10) {
    reasons.push("better comfort");
  }

  return reasons.length ? reasons.slice(0, 3).join(", ") : "steadier conditions";
}

function getImprovementMessage(eventResult: EventAnalysis) {
  const reasons = eventResult.reasons;

  if (
    reasons.some((reason) =>
      ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(reason)
    )
  ) {
    return "Thunderstorm risk decreases after this period";
  }

  if (
    reasons.some((reason) =>
      ["snow may affect conditions", "ice or freezing rain risk", "dangerous cold risk"].includes(reason)
    )
  ) {
    return "Conditions improve later as snow and cold ease";
  }

  return "Conditions improve later";
}

function formatEventInsightRisk(reason: string) {
  if (
    ["thunderstorms possible", "severe storms possible", "tornado risk mentioned"].includes(reason)
  ) {
    return "thunderstorm risk";
  }
  if (reason === "heavy rain or flooding risk") return "flood risk";
  if (reason === "ice or freezing rain risk") return "ice risk";
  if (reason === "snow may affect conditions") return "snow risk";
  if (reason === "dangerous heat risk") return "heat risk";
  if (reason === "dangerous cold risk") return "cold risk";
  return "weather risk";
}

function inferMainConcern(hours: ScoredHour[]) {
  const reasons = summarizeReasons(hours);
  const hasActiveStormAlert = hours.some(
    (hour) =>
      hour.activeAlertImpact !== "none" &&
      hour.reasons.some((reason) =>
        [
          "thunderstorms possible",
          "severe storms possible",
          "tornado risk mentioned"
        ].includes(reason)
      )
  );
  const hasStorm = hours.some((hour) =>
    hour.reasons.some((reason) =>
      [
        "thunderstorms possible",
        "severe storms possible",
        "tornado risk mentioned"
      ].includes(reason)
    )
  );
  const hasSnowOrIce = hours.some((hour) =>
    hour.reasons.some((reason) =>
      ["snow may affect conditions", "ice or freezing rain risk"].includes(reason)
    )
  );
  const hasFlood = hours.some((hour) =>
    hour.reasons.includes("heavy rain or flooding risk")
  );
  const hasCold = hours.some((hour) => {
    const feelsLike = hour.forecast.apparentTemperatureF ?? hour.forecast.temperatureF;
    return (
      (feelsLike !== null && feelsLike <= 34) ||
      hour.reasons.includes("dangerous cold risk")
    );
  });
  const hasLowVisibility = hours.some((hour) =>
    hour.reasons.some(
      (reason) =>
        reason.startsWith("reduced visibility") || reason === "fog may reduce visibility"
    )
  );

  if (hours.some((hour) => hour.activeAlertImpact === "severe")) {
    return "active warning overlaps the event";
  }

  if (hasActiveStormAlert) {
    return "active storm risk during the event";
  }

  if (hasSnowOrIce && hasCold && hasLowVisibility) {
    return "snow, cold, and reduced visibility";
  }

  if ((hasStorm || hasSnowOrIce || hasFlood) && hasCold) {
    return "hazardous precipitation and cold conditions";
  }

  if (hasStorm) {
    return "thunderstorms possible during the event";
  }

  if (hasFlood || hasSnowOrIce) {
    return "hazardous precipitation";
  }

  return reasons[0] ?? "mixed weather conditions";
}

function buildWorstWindow(hours: ScoredHour[]) {
  if (!hours.length) return null;

  const windows = mergeHoursIntoWindows(hours);
  windows.sort((a, b) => {
    const severityRank = (window: TimeWindow) =>
      window.classification === "avoid" ? 0 : window.classification === "caution" ? 1 : 2;
    if (severityRank(a) !== severityRank(b)) {
      return severityRank(a) - severityRank(b);
    }
    return a.averageScore - b.averageScore;
  });

  return windows[0] ?? null;
}

function analyzeEventRange(
  scoredHours: ScoredHour[],
  startTime: string,
  endTime: string,
  activity: DecisionResponse["activity"],
  timeZone: string,
  coordinates?: {
    latitude?: number | null;
    longitude?: number | null;
  },
  options?: {
    now?: Date;
  }
): EventAnalysis {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const durationMs = endMs - startMs;

  const overlappingHours = scoredHours.filter((hour) => overlapMs(hour, startMs, endMs) > 0);
  if (!overlappingHours.length) {
    throw new Error("This event is outside the available hourly forecast range.");
  }

  const weightedScoreTotal = overlappingHours.reduce(
    (sum, hour) => sum + hour.score * overlapMs(hour, startMs, endMs),
    0
  );
  const totalOverlapMs = overlappingHours.reduce(
    (sum, hour) => sum + overlapMs(hour, startMs, endMs),
    0
  );
  const averageScore = Math.round(weightedScoreTotal / totalOverlapMs);
  const avoidOverlapRatio =
    overlappingHours.reduce((sum, hour) => {
      if (hour.classification !== "avoid") return sum;
      return sum + overlapMs(hour, startMs, endMs);
    }, 0) / totalOverlapMs;
  const cautionOrAvoidRatio =
    overlappingHours.reduce((sum, hour) => {
      if (hour.classification === "good") return sum;
      return sum + overlapMs(hour, startMs, endMs);
    }, 0) / totalOverlapMs;

  const shortEvent = durationMs <= 3 * 60 * 60 * 1000;
  const hasAnyAvoid = overlappingHours.some((hour) => hour.classification === "avoid");
  const hasBlockingHazard = overlappingHours.some(
    (hour) =>
      hour.activeAlertImpact === "severe" ||
      hour.reasons.some((reason) => severeEventReasons.has(reason))
  );

  let finalScore = averageScore;
  if (hasBlockingHazard) {
    finalScore = Math.min(finalScore, 20);
  } else if (avoidOverlapRatio >= 0.25) {
    finalScore = Math.min(finalScore, 39);
  } else if (shortEvent && hasAnyAvoid) {
    finalScore = Math.min(finalScore, 39);
  } else if (hasAnyAvoid) {
    finalScore = Math.min(finalScore, 79);
  } else if (cautionOrAvoidRatio >= 0.4) {
    finalScore = Math.min(finalScore, 79);
  }
  finalScore = Math.round(Math.max(0, Math.min(finalScore, 100)));
  const classification = classifyScore(finalScore);

  const now = options?.now ?? new Date();
  const hoursOut = (startMs - now.getTime()) / (60 * 60 * 1000);
  const confidenceNote =
    hoursOut >= 72
      ? "Longer-range timing may change. Use this as early guidance and recheck later."
      : hoursOut >= 48
        ? "Forecast confidence decreases this far out. Recheck closer to the event."
        : undefined;
  const daylightNote =
    getActivityConfig(activity).daylightPreference === "required" &&
    !isMostlyDaylightWindow(
      startTime,
      endTime,
      coordinates?.latitude,
      coordinates?.longitude,
      timeZone
    )
      ? "This activity usually requires daylight."
      : undefined;

  return {
    startTime,
    endTime,
    durationMs,
    score: finalScore,
    rating: deriveWindowRating(finalScore),
    classification,
    reasons: summarizeReasons(overlappingHours),
    overlappingHours,
    worstWindow: buildWorstWindow(overlappingHours),
    bestAlternateWindow: null,
    bestAlternateReason: undefined,
    mainConcern: inferMainConcern(overlappingHours),
    confidenceNote,
    daylightNote
  };
}

function buildCandidateWindow(
  scoredHours: ScoredHour[],
  startIndex: number,
  durationMs: number
) {
  const startTime = scoredHours[startIndex]?.forecast.startTime;
  if (!startTime) return null;

  const startMs = new Date(startTime).getTime();
  const targetEndMs = startMs + durationMs;
  const candidateHours: ScoredHour[] = [];

  for (let index = startIndex; index < scoredHours.length; index += 1) {
    const hour = scoredHours[index];
    if (candidateHours.length) {
      const previousEnd = new Date(candidateHours[candidateHours.length - 1].forecast.endTime).getTime();
      const nextStart = new Date(hour.forecast.startTime).getTime();
      if (Math.abs(nextStart - previousEnd) > 5 * 60 * 1000) {
        return null;
      }
    }

    candidateHours.push(hour);
    const candidateEndMs = new Date(hour.forecast.endTime).getTime();
    if (candidateEndMs >= targetEndMs) {
      return {
        startTime,
        endTime: new Date(targetEndMs).toISOString(),
        hours: candidateHours
      };
    }
  }

  return null;
}

function buildAlternateTimeWindow(analysis: EventAnalysis): TimeWindow {
  return {
    startTime: analysis.startTime,
    endTime: analysis.endTime,
    classification: analysis.classification,
    rating: analysis.rating,
    averageScore: analysis.score,
    reasons: analysis.reasons,
    hours: analysis.overlappingHours
  };
}

export function resolveEventWindow(params: {
  eventStartDate?: string;
  eventEndDate?: string;
  eventDate?: string;
  eventStartTime: string;
  eventEndTime: string;
  timeZone: string;
}) {
  const eventStartDate = params.eventStartDate ?? params.eventDate;
  const eventEndDate = params.eventEndDate ?? params.eventDate;
  const { eventStartTime, eventEndTime, timeZone } = params;

  if (!eventStartDate || !eventEndDate) {
    throw new Error("Please enter a start date, start time, end date, and end time.");
  }

  const startIso = zonedDateTimeToIso(eventStartDate, eventStartTime, timeZone);
  const endIso = zonedDateTimeToIso(eventEndDate, eventEndTime, timeZone);

  if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
    throw new Error("Please make sure the event end date and time are after the start.");
  }

  return {
    startTime: startIso,
    endTime: endIso,
    durationMs: new Date(endIso).getTime() - new Date(startIso).getTime()
  };
}

export function validateEventWindowRange(
  forecastHours: ScoredHour[] | { forecast: { startTime: string; endTime: string } }[],
  eventStartTime: string,
  eventEndTime: string
) {
  if (!forecastHours.length) {
    throw new Error("No forecast hours are available for that timeframe yet.");
  }

  const firstStart = new Date(forecastHours[0].forecast.startTime).getTime();
  const lastEnd = new Date(forecastHours[forecastHours.length - 1].forecast.endTime).getTime();
  const startMs = new Date(eventStartTime).getTime();
  const endMs = new Date(eventEndTime).getTime();

  if (startMs < firstStart || endMs > lastEnd) {
    throw new Error("This event is outside the available hourly forecast range.");
  }
}

export function findBestAlternateEventWindow(params: {
  scoredHours: ScoredHour[];
  eventAnalysis: EventAnalysis;
  activity: DecisionResponse["activity"];
  timeZone: string;
  latitude?: number | null;
  longitude?: number | null;
}) {
  const { scoredHours, eventAnalysis, activity, timeZone, latitude, longitude } = params;
  const originalStart = new Date(eventAnalysis.startTime).getTime();
  const originalEnd = new Date(eventAnalysis.endTime).getTime();
  const originalRank =
    eventAnalysis.classification === "good" ? 2 : eventAnalysis.classification === "caution" ? 1 : 0;
  const candidates: Array<{
    analysis: EventAnalysis;
    distanceHours: number;
    daytimeBonus: number;
  }> = [];

  for (let index = 0; index < scoredHours.length; index += 1) {
    const candidate = buildCandidateWindow(scoredHours, index, eventAnalysis.durationMs);
    if (!candidate) continue;

    const candidateStartMs = new Date(candidate.startTime).getTime();
    const candidateEndMs = new Date(candidate.endTime).getTime();
    const overlapsOriginal =
      candidateStartMs < originalEnd && candidateEndMs > originalStart;
    if (overlapsOriginal) continue;

    const analysis = analyzeEventRange(
      scoredHours,
      candidate.startTime,
      candidate.endTime,
      activity,
      timeZone,
      { latitude, longitude }
    );
    if (analysis.classification === "avoid") continue;

    const candidateRank =
      analysis.classification === "good" ? 2 : analysis.classification === "caution" ? 1 : 0;
    if (candidateRank < originalRank || (candidateRank === originalRank && analysis.score <= eventAnalysis.score)) {
      continue;
    }

    const distanceHours = Math.abs(candidateStartMs - originalStart) / (60 * 60 * 1000);
    const averageHour =
      analysis.overlappingHours.reduce(
        (sum, hour) => sum + getZonedHour(hour.forecast.startTime, timeZone),
        0
      ) / analysis.overlappingHours.length;
    const activityConfig = getActivityConfig(activity);
    const daytimeBonus = activityConfig.daylightPreference === "required"
      ? analysis.overlappingHours.every((hour) =>
          isDaylightHour(hour.forecast, latitude, longitude, timeZone)
        )
        ? 2
        : -1
      : activityConfig.daylightPreference === "preferred"
        ? analysis.overlappingHours.every((hour) =>
            isDaylightHour(hour.forecast, latitude, longitude, timeZone)
          )
          ? 1
          : isLateNightWindow(analysis.startTime, analysis.endTime, timeZone)
            ? -1
            : 0
        : averageHour >= 8 && averageHour <= 21
        ? 1
        : 0;

    candidates.push({
      analysis,
      distanceHours,
      daytimeBonus
    });
  }

  candidates.sort((a, b) => {
    const rankA = a.analysis.classification === "good" ? 2 : 1;
    const rankB = b.analysis.classification === "good" ? 2 : 1;
    if (rankB !== rankA) return rankB - rankA;
    if (b.daytimeBonus !== a.daytimeBonus) return b.daytimeBonus - a.daytimeBonus;
    if (b.analysis.score !== a.analysis.score) return b.analysis.score - a.analysis.score;
    return a.distanceHours - b.distanceHours;
  });

  return candidates[0] ? buildAlternateTimeWindow(candidates[0].analysis) : null;
}

export function getEventTimelineHours(params: {
  scoredHours: ScoredHour[];
  eventStartTime: string;
  eventEndTime: string;
  alternateWindow?: TimeWindow | null;
}) {
  const { scoredHours, eventStartTime, eventEndTime, alternateWindow } = params;
  const sliceStart = new Date(eventStartTime).getTime() - 6 * 60 * 60 * 1000;
  const sliceEnd = Math.max(
    new Date(eventEndTime).getTime(),
    alternateWindow ? new Date(alternateWindow.endTime).getTime() : 0
  ) + 6 * 60 * 60 * 1000;

  return scoredHours.filter((hour) => {
    const start = new Date(hour.forecast.startTime).getTime();
    const end = new Date(hour.forecast.endTime).getTime();
    return end > sliceStart && start < sliceEnd;
  });
}

export function scorePlannedEvent(params: {
  scoredHours: ScoredHour[];
  eventStartDate?: string;
  eventEndDate?: string;
  eventDate?: string;
  eventStartTime: string;
  eventEndTime: string;
  timeZone: string;
  activity: DecisionResponse["activity"];
  suggestAlternates: boolean;
  latitude?: number | null;
  longitude?: number | null;
  now?: Date;
}) {
  const {
    scoredHours,
    eventStartTime,
    eventEndTime,
    timeZone,
    activity,
    suggestAlternates,
    latitude,
    longitude,
    now
  } = params;

  const resolved = resolveEventWindow({
    eventStartDate: params.eventStartDate,
    eventEndDate: params.eventEndDate,
    eventDate: params.eventDate,
    eventStartTime,
    eventEndTime,
    timeZone
  });
  validateEventWindowRange(scoredHours, resolved.startTime, resolved.endTime);

  const analysis = analyzeEventRange(
    scoredHours,
    resolved.startTime,
    resolved.endTime,
    activity,
    timeZone,
    { latitude, longitude },
    { now }
  );

  if (suggestAlternates && analysis.classification !== "good") {
    const bestAlternateWindow = findBestAlternateEventWindow({
      scoredHours,
      eventAnalysis: analysis,
      activity,
      timeZone,
      latitude,
      longitude
    });
    analysis.bestAlternateWindow = bestAlternateWindow;
    if (bestAlternateWindow) {
      const alternateAnalysis = analyzeEventRange(
        scoredHours,
        bestAlternateWindow.startTime,
        bestAlternateWindow.endTime,
        activity,
        timeZone,
        { latitude, longitude }
      );
      analysis.bestAlternateReason = buildAlternateReason(analysis, alternateAnalysis);
      if (
        new Date(bestAlternateWindow.startTime).getTime() - new Date(analysis.endTime).getTime() >=
        48 * 60 * 60 * 1000
      ) {
        analysis.guidanceNote = "Forecast confidence is lower this far out.";
      }
    }
  }

  return analysis;
}

export function buildEventSummary(params: {
  eventResult: EventAnalysis;
  timeZone: string;
  hourly: ScoredHour[];
  alerts?: WeatherAlert[];
}): DecisionResponse["summary"] {
  const { eventResult, timeZone, hourly, alerts = [] } = params;
  const eventEndMs = new Date(eventResult.endTime).getTime();
  const futureStormRisk = hourly.some((hour) => {
    const startMs = new Date(hour.forecast.startTime).getTime();
    return (
      startMs >= eventEndMs &&
      hour.reasons.some((reason) =>
        ["thunderstorms possible", "severe storms possible", "heavy rain or flooding risk"].includes(
          reason
        )
      )
    );
  });
  const floodContext = formatFloodAlertContext(
    alerts,
    eventResult.startTime,
    eventResult.endTime,
    timeZone
  );
  const hasActiveWarningOverlap = eventResult.overlappingHours.some(
    (hour) => hour.activeAlertImpact === "severe"
  );
  const hasWeatherBlockingHazard = eventResult.overlappingHours.some((hour) =>
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
  const hasAqiBlockingHazard = eventResult.overlappingHours.some((hour) =>
    hour.reasons.some((reason) =>
      ["air quality may affect sensitive groups", "unhealthy air quality"].includes(reason)
    )
  );
  const hasTempBlockingHazard = eventResult.overlappingHours.some((hour) =>
    hour.reasons.some((reason) =>
      ["dangerous heat risk", "dangerous cold risk"].includes(reason)
    )
  );
  const messageType: DecisionResponse["summary"]["messageType"] = hasActiveWarningOverlap
    ? "alert_blocked"
    : eventResult.rating === "Avoid" && hasWeatherBlockingHazard
      ? "weather_blocked"
      : eventResult.rating !== "Good" && hasAqiBlockingHazard
        ? "aqi_blocked"
        : eventResult.rating !== "Good" && hasTempBlockingHazard
          ? "temp_blocked"
          : eventResult.rating === "Caution"
            ? "fallback"
            : "normal";
  const activeWarningContextNote = hasActiveWarningOverlap
    ? "Active warning in effect. Follow official instructions."
    : undefined;
  const heading =
    eventResult.rating === "Good"
      ? "Your event looks good"
      : eventResult.rating === "Caution"
        ? "Use caution for this event"
        : "Consider rescheduling";
  const explanation =
    eventResult.rating === "Good"
      ? "This planned window has favorable conditions based on the available forecast."
      : eventResult.rating === "Caution"
        ? "This event may still work, but weather could affect comfort or safety."
        : "Outdoor plans are not recommended during this planned window.";
  const confidence =
    eventResult.confidenceNote && eventResult.confidenceNote.includes("Longer-range")
      ? "Low"
      : eventResult.confidenceNote
        ? "Medium"
        : eventResult.rating === "Avoid"
          ? "Low"
          : eventResult.rating === "Caution"
            ? "Medium"
            : "High";
  const confidenceExplanation =
    eventResult.confidenceNote ??
    (eventResult.rating === "Good"
      ? "This event window looks favorable within the available hourly forecast."
      : eventResult.rating === "Caution"
        ? "Some weather factors could still affect this event window."
        : "Hazards overlap this event window, so outdoor plans look risky.");
  const highlightInsight = (() => {
    if (eventResult.rating !== "Good" && eventResult.worstWindow) {
      return `The worst conditions occur between ${formatHourRange(
        eventResult.worstWindow.startTime,
        eventResult.worstWindow.endTime,
        timeZone
      )}.`;
    }

    if (futureStormRisk) {
      return "Most of your event is fine, but thunderstorms may return later in the day.";
    }

    const firstLimitingHour = eventResult.overlappingHours.find(
      (hour) =>
        hour.classification !== "good" ||
        hour.reasons.some((reason) =>
          [
            "thunderstorms possible",
            "severe storms possible",
            "heavy rain or flooding risk",
            "ice or freezing rain risk",
            "snow may affect conditions",
            "dangerous heat risk",
            "dangerous cold risk"
          ].includes(reason)
        )
    );
    const limitingReason = firstLimitingHour?.reasons.find((reason) =>
      [
        "thunderstorms possible",
        "severe storms possible",
        "heavy rain or flooding risk",
        "ice or freezing rain risk",
        "snow may affect conditions",
        "dangerous heat risk",
        "dangerous cold risk"
      ].includes(reason)
    );

    if (eventResult.rating === "Good" && firstLimitingHour && limitingReason) {
      return `Most of your event is fine, but ${formatEventInsightRisk(
        limitingReason
      )} peaks around ${formatZonedTime(firstLimitingHour.forecast.startTime, timeZone)}.`;
    }

    return "Most of your event looks steady in the current forecast.";
  })();

  return {
    recommendation: formatHourRange(eventResult.startTime, eventResult.endTime, timeZone),
    heading,
    confidence: confidence as "High" | "Medium" | "Low",
    confidenceExplanation,
    explanation,
    messageType,
    highlightInsight,
    note: eventResult.daylightNote,
    banner: undefined,
    bannerTone: undefined,
    emphasis: messageType === "normal" ? "normal" : "caution",
    clearRiskLine: undefined,
    decisionChip:
      messageType === "fallback" && isLateNightWindow(eventResult.startTime, eventResult.endTime, timeZone)
        ? "Late-night option"
        : undefined,
    contextNote:
      activeWarningContextNote ??
      floodContext ??
      (messageType === "normal" && futureStormRisk
        ? "Thunderstorms may return later."
        : eventResult.bestAlternateWindow
          ? getImprovementMessage(eventResult)
          : undefined),
    riskTrend: messageType === "normal" && !futureStormRisk && !floodContext ? "Conditions stable" : undefined,
    mainFactor:
      messageType === "alert_blocked"
        ? "active weather warnings"
        : messageType === "weather_blocked"
          ? "storms or heavy precipitation limit outdoor plans"
          : messageType === "aqi_blocked"
            ? "unhealthy air quality"
            : messageType === "temp_blocked"
              ? "extreme temperatures limit outdoor plans"
              : eventResult.mainConcern
  };
}

export function formatWorstPeriod(eventResult: EventAnalysis, timeZone: string) {
  if (!eventResult.worstWindow) return null;
  return formatHourRange(
    eventResult.worstWindow.startTime,
    eventResult.worstWindow.endTime,
    timeZone
  );
}

export function getEventRangeInputValues(eventResult: EventAnalysis, timeZone: string) {
  return {
    date: formatDateInputValue(eventResult.startTime, timeZone),
    startTime: formatZonedTime(eventResult.startTime, timeZone),
    endTime: formatZonedTime(eventResult.endTime, timeZone)
  };
}
