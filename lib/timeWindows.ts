import { ActivityMode, HourClassification, ScoredHour, TimeHorizon, TimeWindow } from "@/lib/types";
import {
  getActivityConfig,
  isLateNightHour,
  isLateNightWindow
} from "@/lib/activityConfig";
import {
  getDaylightWindowTier,
  isDaylightHour,
  isMostlyDaylightWindow
} from "@/lib/daylight";
import { getZonedDateParts, isSameZonedDay } from "@/lib/utils";

interface DaylightContext {
  latitude?: number | null;
  longitude?: number | null;
}

function summarizeWindowReasons(hours: ScoredHour[]) {
  const counts = new Map<string, number>();

  for (const hour of hours) {
    for (const reason of hour.reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => reason);
}

export function mergeHoursIntoWindows(hours: ScoredHour[]) {
  const windows: TimeWindow[] = [];

  for (const hour of hours) {
    const last = windows[windows.length - 1];
    if (!last || last.classification !== hour.classification) {
      windows.push({
        startTime: hour.forecast.startTime,
        endTime: hour.forecast.endTime,
        classification: hour.classification,
        rating: hour.rating,
        averageScore: hour.score,
        reasons: [...hour.reasons],
        hours: [hour]
      });
      continue;
    }

    last.endTime = hour.forecast.endTime;
    last.hours.push(hour);
    last.averageScore = Math.round(
      last.hours.reduce((sum, item) => sum + item.score, 0) / last.hours.length
    );
    last.classification = classifyScore(last.averageScore);
    last.rating = deriveWindowRating(last.averageScore);
    last.reasons = summarizeWindowReasons(last.hours);
  }

  return windows;
}

export function deriveWindowRating(score: number) {
  if (score >= 80) return "Good";
  if (score >= 40) return "Caution";
  return "Avoid";
}

export function getWindowClassificationScoreLabel(classification: HourClassification) {
  if (classification === "good") return "Good";
  if (classification === "caution") return "Caution";
  return "Avoid";
}

function isContiguousWindow(hours: ScoredHour[]) {
  for (let index = 1; index < hours.length; index += 1) {
    const previousEnd = new Date(hours[index - 1].forecast.endTime).getTime();
    const nextStart = new Date(hours[index].forecast.startTime).getTime();
    if (Math.abs(nextStart - previousEnd) > 5 * 60 * 1000) {
      return false;
    }
  }

  return true;
}

function getPracticalTimeScore(
  windowHours: ScoredHour[],
  horizon: TimeHorizon,
  timeZone: string,
  activity: ActivityMode,
  daylightContext?: DaylightContext
) {
  const start = windowHours[0].forecast.startTime;
  const end = windowHours[windowHours.length - 1].forecast.endTime;
  const startHour = getZonedDateParts(start, timeZone).hour;
  const endHour = getZonedDateParts(end, timeZone).hour;
  const crossesMidnight = !isSameZonedDay(start, end, timeZone);
  const config = getActivityConfig(activity);
  const isDaylightWindow = isMostlyDaylightWindow(
    start,
    end,
    daylightContext?.latitude,
    daylightContext?.longitude,
    timeZone
  );
  const isLateNight = isLateNightWindow(start, end, timeZone);
  const daylightBonus =
    config.daylightPreference === "required"
      ? isDaylightWindow
        ? 4
        : -8
      : config.daylightPreference === "preferred"
        ? isDaylightWindow
          ? 2
          : isLateNight
            ? -5
            : -1
        : 0;

  if (horizon === "today") {
    if (endHour <= 20 && startHour >= 7 && !crossesMidnight) return 4 + daylightBonus;
    if (endHour <= 20 && startHour >= 6 && !crossesMidnight) return 3 + daylightBonus;
    if (endHour <= 20 && !crossesMidnight) return 2 + daylightBonus;
    return daylightBonus;
  }

  if (horizon === "tonight") {
    const nightFriendly =
      startHour >= 20 || startHour < 6 || crossesMidnight || endHour <= 6;
    if (!nightFriendly) return daylightBonus;
    if (startHour >= 20 || crossesMidnight) return 4 + daylightBonus;
    if (startHour < 6 || endHour <= 6) return 3 + daylightBonus;
    return 2 + daylightBonus;
  }

  if (crossesMidnight) return daylightBonus;
  if (startHour >= 7 && endHour <= 20) return 3 + daylightBonus;
  if (startHour >= 6 && endHour <= 21) return 2 + daylightBonus;
  if (startHour >= 5 && endHour <= 22) return 1 + daylightBonus;
  return daylightBonus;
}

function buildCompactWindow(windowHours: ScoredHour[]): TimeWindow {
  const averageScore = Math.round(
    windowHours.reduce((sum, hour) => sum + hour.score, 0) / windowHours.length
  );
  const classification = classifyScore(averageScore);

  return {
    startTime: windowHours[0].forecast.startTime,
    endTime: windowHours[windowHours.length - 1].forecast.endTime,
    classification,
    rating: deriveWindowRating(averageScore),
    averageScore,
    reasons: summarizeWindowReasons(windowHours),
    hours: windowHours
  };
}

function selectCompactWindow(
  hours: ScoredHour[],
  horizon: TimeHorizon,
  timeZone: string,
  activity: ActivityMode,
  daylightContext?: DaylightContext
): TimeWindow | null {
  const candidates: Array<{
    window: TimeWindow;
    adjustedScore: number;
    cautionHours: number;
    avoidHours: number;
    bufferHours: number;
    goodHours: number;
    practicalScore: number;
    daylightTier: "daylight" | "mixed-light" | "night";
    lateNightHours: number;
    startsAt: number;
  }> = [];

  const config = getActivityConfig(activity);
  const candidateLengths = Array.from(
    new Set(
      [config.minPreferredWindowHours, config.minPreferredWindowHours + 1, config.minPreferredWindowHours + 2].filter(
        (length) => length >= 1 && length <= 6
      )
    )
  );

  for (const length of candidateLengths) {
    for (let startIndex = 0; startIndex <= hours.length - length; startIndex += 1) {
      const windowHours = hours.slice(startIndex, startIndex + length);
      if (!isContiguousWindow(windowHours)) continue;

      const window = buildCompactWindow(windowHours);
      const cautionHours = windowHours.filter(
        (hour) => hour.classification === "caution"
      ).length;
      const avoidHours = windowHours.filter(
        (hour) => hour.classification === "avoid"
      ).length;
      const bufferHours = windowHours.filter(
        (hour) =>
          hour.alertContext === "recent-alert" || hour.alertContext === "recent-watch"
      ).length;
      const goodHours = windowHours.filter((hour) => hour.classification === "good").length;
      const daylightHours = windowHours.filter((hour) =>
        isDaylightHour(
          hour.forecast,
          daylightContext?.latitude,
          daylightContext?.longitude,
          timeZone
        )
      ).length;
      const lateNightHours = windowHours.filter((hour) =>
        isLateNightHour(hour.forecast.startTime, timeZone)
      ).length;
      const daylightTier = getDaylightWindowTier(
        window.startTime,
        window.endTime,
        daylightContext?.latitude,
        daylightContext?.longitude,
        timeZone
      );
      const practicalScore = getPracticalTimeScore(
        windowHours,
        horizon,
        timeZone,
        activity,
        daylightContext
      );
      const adjustedScore =
        window.averageScore -
        avoidHours * 60 -
        cautionHours * 8 -
        bufferHours * 12 +
        practicalScore * 2 +
        (config.daylightPreference === "required"
          ? daylightHours * 4 -
            (daylightTier === "night" ? 10 : daylightTier === "mixed-light" ? 3 : 0)
          : config.daylightPreference === "preferred"
            ? daylightHours * 2 -
              lateNightHours * 4 -
              (daylightTier === "night"
                ? config.nightSensitivity * 3
                : daylightTier === "mixed-light"
                  ? Math.max(0, config.nightSensitivity - 2)
                  : 0)
            : 0);

      candidates.push({
        window,
        adjustedScore,
        cautionHours,
        avoidHours,
        bufferHours,
        goodHours,
        practicalScore,
        daylightTier,
        lateNightHours,
        startsAt: new Date(window.startTime).getTime()
      });
    }
  }

  if (!candidates.length) {
    return null;
  }

  let preferredCandidates = candidates;

  const usableCandidates = preferredCandidates.filter((candidate) => candidate.avoidHours === 0);
  if (usableCandidates.length) {
    preferredCandidates = usableCandidates;
  }

  const allGoodCandidates = preferredCandidates.filter(
    (candidate) => candidate.goodHours === candidate.window.hours.length
  );
  if (allGoodCandidates.length) {
    preferredCandidates = allGoodCandidates;
  }

  const nonBufferCandidates = preferredCandidates.filter(
    (candidate) => candidate.bufferHours === 0
  );
  if (nonBufferCandidates.length) {
    preferredCandidates = nonBufferCandidates;
  }

  if (config.daylightPreference === "required") {
    const daylightCandidates = preferredCandidates.filter(
      (candidate) =>
        candidate.avoidHours === 0 &&
        candidate.window.classification !== "avoid" &&
        candidate.daylightTier === "daylight"
    );
    if (daylightCandidates.length) {
      preferredCandidates = daylightCandidates;
    } else {
      const mixedLightCandidates = preferredCandidates.filter(
        (candidate) =>
          candidate.avoidHours === 0 &&
          candidate.window.classification !== "avoid" &&
          candidate.daylightTier === "mixed-light"
      );
      if (mixedLightCandidates.length) {
        preferredCandidates = mixedLightCandidates;
      } else if (horizon === "tonight") {
        return null;
      }
    }
  }

  if (config.daylightPreference === "preferred") {
    const daylightOrMixedCandidates = preferredCandidates.filter(
      (candidate) =>
        candidate.avoidHours === 0 &&
        candidate.window.classification !== "avoid" &&
        candidate.daylightTier !== "night"
    );
    if (daylightOrMixedCandidates.length) {
      preferredCandidates = daylightOrMixedCandidates;
    }

    const daylightCandidates = preferredCandidates.filter(
      (candidate) =>
        candidate.avoidHours === 0 &&
        candidate.window.classification !== "avoid" &&
        candidate.daylightTier === "daylight"
    );
    if (daylightCandidates.length) {
      preferredCandidates = daylightCandidates;
    }
  }

  preferredCandidates.sort((a, b) => {
    if (b.adjustedScore !== a.adjustedScore) return b.adjustedScore - a.adjustedScore;
    if (b.window.averageScore !== a.window.averageScore) {
      return b.window.averageScore - a.window.averageScore;
    }
    if (a.cautionHours !== b.cautionHours) return a.cautionHours - b.cautionHours;
    if (b.practicalScore !== a.practicalScore) return b.practicalScore - a.practicalScore;
    return a.startsAt - b.startsAt;
  });

  const selectedCandidate = preferredCandidates[0];
  if (!selectedCandidate) {
    return null;
  }

  const selectedAsDaylightFallback =
    config.daylightPreference === "required" &&
    selectedCandidate.daylightTier !== "daylight";
  const selectedUsesModerateAlert = selectedCandidate.window.hours.some(
    (hour) => hour.activeAlertImpact === "moderate"
  );
  const selectedUsesRecentAlertBuffer = selectedCandidate.window.hours.some(
    (hour) =>
      hour.alertContext === "recent-alert" || hour.alertContext === "recent-watch"
  );
  const cappedAverageScore =
    selectedAsDaylightFallback || selectedUsesModerateAlert || selectedUsesRecentAlertBuffer
      ? Math.min(selectedCandidate.window.averageScore, 79)
      : selectedCandidate.window.averageScore;

  return {
    ...selectedCandidate.window,
    averageScore: cappedAverageScore,
    classification: classifyScore(cappedAverageScore),
    rating: deriveWindowRating(cappedAverageScore),
    daylightTier: selectedCandidate.daylightTier,
    selectedAsDaylightFallback
  };
}

export function selectBestWindows(
  windows: TimeWindow[],
  hours: ScoredHour[],
  horizon: TimeHorizon,
  timeZone: string,
  activity: ActivityMode = "social",
  daylightContext?: DaylightContext
) {
  const compactCandidates = hours.filter((hour) => hour.alertImpact !== "severe");
  const rawBestWindow = selectCompactWindow(
    compactCandidates,
    horizon,
    timeZone,
    activity,
    daylightContext
  );
  const bestWindow = rawBestWindow?.classification === "avoid" ? null : rawBestWindow;

  const alternativeCompactCandidates = hours.filter((hour) => {
    if (!bestWindow) return hour.alertImpact !== "severe";
    const time = new Date(hour.forecast.startTime).getTime();
    return (
      hour.alertImpact !== "severe" &&
      (time < new Date(bestWindow.startTime).getTime() ||
        time >= new Date(bestWindow.endTime).getTime())
    );
  });
  const secondaryWindow = selectCompactWindow(
    alternativeCompactCandidates,
    horizon,
    timeZone,
    activity,
    daylightContext
  );

  return {
    bestWindow,
    secondaryWindow,
    cautionWindows: windows.filter((window) => window.classification === "caution"),
    avoidWindows: windows.filter((window) => window.classification === "avoid")
  };
}

export function classifyScore(score: number): HourClassification {
  if (score >= 80) return "good";
  if (score >= 40) return "caution";
  return "avoid";
}
