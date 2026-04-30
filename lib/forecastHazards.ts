import { ActivityMode, ForecastHour } from "@/lib/types";
import { getActivityConfig } from "@/lib/activityConfig";
import { getZonedHour } from "@/lib/utils";

export type ForecastHazardKind =
  | "thunderstorms"
  | "severe-storms"
  | "tornado"
  | "ice"
  | "snow"
  | "heavy-snow"
  | "flooding"
  | "heat"
  | "cold"
  | "fog"
  | "dense-fog"
  | "smoke"
  | "dense-smoke";

export type PrecipType =
  | "rain"
  | "snow"
  | "mix"
  | "ice"
  | "thunderstorms"
  | "precip";

export interface ForecastHazard {
  kind: ForecastHazardKind;
  reason: string;
}

function parseTimeToken(token: string) {
  const normalized = token.trim().toLowerCase().replace(/\./g, "");

  if (normalized === "midnight") {
    return { hour24: 0, period: "night" as const, token: normalized };
  }

  if (normalized === "noon") {
    return { hour24: 12, period: "day" as const, token: normalized };
  }

  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (!match) return null;

  let hour = Number(match[1]) % 12;
  const meridiem = match[3];
  if (meridiem === "pm") {
    hour += 12;
  }

  return {
    hour24: hour,
    period: meridiem === "am" ? ("morning" as const) : ("afternoon" as const),
    token: normalized
  };
}

function hourMatchesRelativeToken(hour: number, token: ReturnType<typeof parseTimeToken>) {
  if (!token) return false;

  if (token.token === "midnight") {
    return hour < 12;
  }

  if (token.token === "noon") {
    return hour >= 12;
  }

  if (token.period === "morning") {
    return hour >= token.hour24 && hour < 12;
  }

  return hour >= token.hour24;
}

function segmentMatchesHour(segment: string, hour: number) {
  const normalized = segment.toLowerCase();
  const betweenMatch = normalized.match(
    /between\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|midnight|noon)\s+and\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|midnight|noon)/
  );

  if (betweenMatch) {
    const start = parseTimeToken(betweenMatch[1]);
    const end = parseTimeToken(betweenMatch[2]);
    if (!start || !end) return false;
    if (start.hour24 < end.hour24) {
      return hour >= start.hour24 && hour < end.hour24;
    }
    return hour >= start.hour24 || hour < end.hour24;
  }

  const afterMatch = normalized.match(
    /after\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|midnight|noon)/
  );
  if (afterMatch) {
    return hourMatchesRelativeToken(hour, parseTimeToken(afterMatch[1]));
  }

  const beforeMatch = normalized.match(
    /before\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|midnight|noon)/
  );
  if (beforeMatch) {
    const token = parseTimeToken(beforeMatch[1]);
    if (!token) return false;
    if (token.token === "midnight") {
      return hour >= 12;
    }
    if (token.period === "afternoon") {
      return hour >= 12 && hour < token.hour24;
    }
    return hour < token.hour24;
  }

  const untilMatch = normalized.match(
    /until\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|midnight|noon)/
  );
  if (untilMatch) {
    const token = parseTimeToken(untilMatch[1]);
    if (!token) return false;
    if (token.token === "midnight") {
      return hour >= 12;
    }
    if (token.period === "afternoon") {
      return hour >= 12 && hour < token.hour24;
    }
    return hour < token.hour24;
  }

  return null;
}

function splitDetailedSegments(text: string) {
  return text
    .split(/\bthen\b/i)
    .map((segment) => segment.replace(/^[,\s]+|[,\s]+$/g, ""))
    .filter(Boolean);
}

export function getRelevantForecastTextForHour(
  hour: ForecastHour,
  forecastText: string,
  timeZone: string
) {
  const segments = splitDetailedSegments(forecastText);
  if (!segments.length) return forecastText;

  const zonedHour = getZonedHour(hour.startTime, timeZone);
  const timedSegments = segments.filter((segment) => segmentMatchesHour(segment, zonedHour) !== null);

  for (const segment of timedSegments) {
    if (segmentMatchesHour(segment, zonedHour)) {
      return segment;
    }
  }

  if (timedSegments.length) {
    return "";
  }

  return forecastText;
}

export function detectPrecipType(
  periodText: string,
  temperatureF: number | null,
  apparentTemperatureF: number | null
): PrecipType {
  const normalized = periodText.toLowerCase();
  const feelsLike = apparentTemperatureF ?? temperatureF;
  const aboveFreezing = (feelsLike ?? temperatureF ?? 33) > 32;

  if (
    normalized.includes("freezing rain") ||
    /\bice\b/.test(normalized) ||
    normalized.includes("icing")
  ) {
    return "ice";
  }

  if (
    normalized.includes("sleet") ||
    normalized.includes("wintry mix") ||
    normalized.includes("rain and snow") ||
    normalized.includes("snow and rain")
  ) {
    return "mix";
  }

  if (normalized.includes("snow likely") || normalized.includes("snow showers") || normalized.includes("snow")) {
    return "snow";
  }

  if (
    normalized.includes("thunderstorm") ||
    normalized.includes("thunderstorms") ||
    normalized.includes("t-storm") ||
    /\bstorms\b/.test(normalized)
  ) {
    return "thunderstorms";
  }

  if (
    aboveFreezing &&
    (normalized.includes("rain") || normalized.includes("showers"))
  ) {
    return "rain";
  }

  return "precip";
}

export function getPrecipLabel(
  periodText: string,
  temperatureF: number | null,
  apparentTemperatureF: number | null
) {
  const normalized = periodText.toLowerCase();
  const precipType = detectPrecipType(periodText, temperatureF, apparentTemperatureF);
  const feelsLike = apparentTemperatureF ?? temperatureF;
  const explicitSnow = normalized.includes("snow");
  const explicitMix =
    normalized.includes("sleet") ||
    normalized.includes("wintry mix") ||
    normalized.includes("rain and snow") ||
    normalized.includes("snow and rain");

  switch (precipType) {
    case "rain":
      return "rain";
    case "snow":
      if (feelsLike !== null && feelsLike > 40) {
        return explicitSnow ? "snow possible" : "precip";
      }
      if (feelsLike !== null && feelsLike > 32) {
        return "snow/mix possible";
      }
      return "snow";
    case "mix":
      if (feelsLike !== null && feelsLike > 40) {
        return "precip";
      }
      if (feelsLike !== null && feelsLike > 32) {
        return explicitSnow || explicitMix ? "snow/mix possible" : "precip";
      }
      return "wintry mix";
    case "ice":
      return "ice/freezing rain";
    case "thunderstorms":
      return "T-storms";
    default:
      return "precip";
  }
}

export function getHourlyPrecipLabel(
  hour: ForecastHour,
  forecastText: string,
  timeZone: string
) {
  if (hour.shortForecast.trim()) {
    return getPrecipLabel(
      hour.shortForecast,
      hour.temperatureF,
      hour.apparentTemperatureF
    );
  }

  const relevantDetailed = getRelevantForecastTextForHour(hour, forecastText, timeZone);
  if (relevantDetailed) {
    const detailedLabel = getPrecipLabel(
      relevantDetailed,
      hour.temperatureF,
      hour.apparentTemperatureF
    );
    if (detailedLabel !== "precip") {
      return detailedLabel;
    }
  }

  return getPrecipLabel(
    [hour.shortForecast, relevantDetailed].filter(Boolean).join(" "),
    hour.temperatureF,
    hour.apparentTemperatureF
  );
}

export function detectForecastHazards(periodText: string): ForecastHazard[] {
  const normalized = periodText.toLowerCase();
  const hazards: ForecastHazard[] = [];

  const addHazard = (kind: ForecastHazardKind, reason: string) => {
    if (!hazards.some((hazard) => hazard.kind === kind)) {
      hazards.push({ kind, reason });
    }
  };

  if (/\btornado(es)?\b/.test(normalized)) {
    addHazard("tornado", "tornado risk mentioned");
  }

  if (
    normalized.includes("severe thunderstorm") ||
    normalized.includes("severe thunderstorms") ||
    normalized.includes("storms could be severe") ||
    normalized.includes("some storms could be severe") ||
    normalized.includes("damaging winds") ||
    normalized.includes("large hail")
  ) {
    addHazard("severe-storms", "severe storms possible");
  }

  if (
    normalized.includes("thunderstorm") ||
    normalized.includes("thunderstorms") ||
    normalized.includes("t-storm") ||
    /\bstorms\b/.test(normalized)
  ) {
    addHazard("thunderstorms", "thunderstorms possible");
  }

  if (
    normalized.includes("freezing rain") ||
    /\bice\b/.test(normalized) ||
    normalized.includes("icing") ||
    normalized.includes("wintry mix") ||
    normalized.includes("sleet")
  ) {
    addHazard("ice", "ice or freezing rain risk");
  }

  if (
    normalized.includes("heavy snow") ||
    normalized.includes("blizzard") ||
    normalized.includes("whiteout") ||
    normalized.includes("snow accumulation") ||
    normalized.includes("accumulating snow")
  ) {
    addHazard("heavy-snow", "snow may affect conditions");
  } else if (normalized.includes("snow") || normalized.includes("snow showers")) {
    addHazard("snow", "snow may affect conditions");
  }

  if (
    normalized.includes("heavy rain") ||
    normalized.includes("flooding") ||
    normalized.includes("flash flooding") ||
    /\bflood\b/.test(normalized)
  ) {
    addHazard("flooding", "heavy rain or flooding risk");
  }

  if (
    normalized.includes("dangerous heat") ||
    normalized.includes("excessive heat") ||
    normalized.includes("heat index") ||
    normalized.includes("extreme heat")
  ) {
    addHazard("heat", "dangerous heat risk");
  }

  if (
    normalized.includes("extreme cold") ||
    normalized.includes("dangerous cold") ||
    normalized.includes("wind chill") ||
    normalized.includes("frostbite")
  ) {
    addHazard("cold", "dangerous cold risk");
  }

  if (normalized.includes("dense fog")) {
    addHazard("dense-fog", "fog may reduce visibility");
  } else if (
    normalized.includes("patchy fog") ||
    normalized.includes("areas of fog") ||
    /\bfog\b/.test(normalized)
  ) {
    addHazard("fog", "fog may reduce visibility");
  }

  if (normalized.includes("dense smoke") || normalized.includes("wildfire smoke")) {
    addHazard("dense-smoke", "smoke may affect air quality");
  } else if (
    normalized.includes("areas of smoke") ||
    normalized.includes("smoke") ||
    normalized.includes("haze")
  ) {
    addHazard("smoke", "smoke may affect air quality");
  }

  return hazards;
}

export function getForecastHazardCap(params: {
  hazards: ForecastHazard[];
  activity: ActivityMode;
  temperatureF: number | null;
  visibilityMiles?: number | null;
  aqi?: number | null;
}) {
  const { hazards, activity, temperatureF, visibilityMiles = null, aqi = null } = params;
  const config = getActivityConfig(activity);
  let classificationCap: "caution" | "avoid" | null = null;
  let strongPenalty = 0;
  const reasons: string[] = [];

  const applyCap = (nextCap: "caution" | "avoid") => {
    if (nextCap === "avoid") {
      classificationCap = "avoid";
      return;
    }
    if (classificationCap !== "avoid") {
      classificationCap = "caution";
    }
  };

  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  for (const hazard of hazards) {
    addReason(hazard.reason);

    if (hazard.kind === "tornado") {
      applyCap("avoid");
      strongPenalty = Math.max(strongPenalty, 90);
      continue;
    }

    if (hazard.kind === "severe-storms" || hazard.kind === "ice" || hazard.kind === "flooding") {
      applyCap("avoid");
      strongPenalty = Math.max(strongPenalty, 80);
      continue;
    }

    if (hazard.kind === "heavy-snow") {
      applyCap("avoid");
      strongPenalty = Math.max(strongPenalty, 75);
      continue;
    }

    if (hazard.kind === "snow" || hazard.kind === "thunderstorms") {
      applyCap("caution");
      strongPenalty = Math.max(strongPenalty, 30);
      continue;
    }

    if (hazard.kind === "dense-fog") {
      if (visibilityMiles !== null && visibilityMiles < 1) {
        applyCap("avoid");
        strongPenalty = Math.max(strongPenalty, 70);
      } else {
        applyCap("caution");
        strongPenalty = Math.max(strongPenalty, 35);
      }
      continue;
    }

    if (hazard.kind === "fog") {
      applyCap("caution");
      strongPenalty = Math.max(strongPenalty, 20);
      continue;
    }

    if (hazard.kind === "dense-smoke") {
      if (aqi !== null && aqi > 150) {
        applyCap("avoid");
        strongPenalty = Math.max(strongPenalty, 70);
      } else {
        applyCap("caution");
        strongPenalty = Math.max(strongPenalty, 35);
      }
      continue;
    }

    if (hazard.kind === "smoke") {
      applyCap("caution");
      strongPenalty = Math.max(strongPenalty, 20);
      continue;
    }

    if (hazard.kind === "heat") {
      if ((temperatureF ?? 0) >= 100) {
        applyCap("avoid");
        strongPenalty = Math.max(strongPenalty, 80);
      } else if ((temperatureF ?? 0) >= 90 || config.heatSensitivity >= 5) {
        applyCap("caution");
        strongPenalty = Math.max(strongPenalty, config.heatSensitivity >= 5 ? 45 : 30);
      }
      continue;
    }

    if (hazard.kind === "cold") {
      if (temperatureF !== null && temperatureF <= 10) {
        applyCap("avoid");
        strongPenalty = Math.max(strongPenalty, 80);
      } else if (temperatureF !== null && temperatureF <= 25) {
        applyCap("caution");
        strongPenalty = Math.max(strongPenalty, 35);
      }
    }
  }

  return {
    classificationCap,
    strongPenalty,
    reasons
  };
}
