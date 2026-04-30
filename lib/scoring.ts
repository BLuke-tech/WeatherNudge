import {
  ActivityMode,
  AlertImpactLevel,
  AirQualityReading,
  ForecastHour,
  HourlyScoreBreakdown,
  ScoredHour,
  WeatherAlert
} from "@/lib/types";
import { getActivityConfig } from "@/lib/activityConfig";
import {
  detectForecastHazards,
  getHourlyPrecipLabel,
  getRelevantForecastTextForHour,
  getForecastHazardCap
} from "@/lib/forecastHazards";
import { clamp, getAqiMeaning, getZonedLocalHourKey } from "@/lib/utils";
import { classifyScore, deriveWindowRating } from "@/lib/timeWindows";

function getActivityWeights(activity: ActivityMode): HourlyScoreBreakdown {
  const config = getActivityConfig(activity);
  const raw = {
    comfort: (config.heatSensitivity + config.coldSensitivity) / 2,
    precipitation:
      config.precipitationSensitivity * 1.15 + config.thunderstormSensitivity * 0.25,
    wind: config.windSensitivity * 0.6 + config.gustSensitivity * 0.4,
    humidity: config.heatSensitivity * 0.85,
    visibility: config.visibilitySensitivity,
    alerts: config.thunderstormSensitivity * 1.1,
    aqi: config.aqiSensitivity
  };
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);

  return {
    comfort: raw.comfort / total,
    precipitation: raw.precipitation / total,
    wind: raw.wind / total,
    humidity: raw.humidity / total,
    visibility: raw.visibility / total,
    alerts: raw.alerts / total,
    aqi: raw.aqi / total
  };
}

function adjustScoreForSensitivity(baseScore: number, sensitivity: number) {
  const multiplier = 0.65 + sensitivity * 0.1;
  return clamp(Math.round(100 - (100 - baseScore) * multiplier), 0, 100);
}

const severeWarningEvents = new Set([
  "tornado warning",
  "severe thunderstorm warning",
  "flash flood warning",
  "extreme wind warning",
  "ice storm warning",
  "winter storm warning",
  "blizzard warning",
  "excessive heat warning",
  "extreme cold warning",
  "wind chill warning"
]);

const watchAlertEvents = new Set([
  "tornado watch",
  "severe thunderstorm watch"
]);

const moderateAlertEvents = new Set([
  "severe thunderstorm watch",
  "flood watch",
  "heat advisory",
  "winter weather advisory"
]);

const severeRiskSummaryEvents = new Set([
  ...severeWarningEvents,
  ...watchAlertEvents
]);

function comfortScore(
  apparentTemperatureF: number | null,
  temperatureF: number | null,
  activity: ActivityMode
) {
  const config = getActivityConfig(activity);
  const feelsLike = apparentTemperatureF ?? temperatureF;
  if (feelsLike === null) return 60;

  if (feelsLike <= 10 || feelsLike >= 105) return 5;
  const baseScore =
    feelsLike <= 24 || feelsLike >= 100
      ? 30
      : feelsLike <= 34 || feelsLike >= 95
        ? 40
        : feelsLike <= 44 || feelsLike >= 89
          ? 58
          : feelsLike <= 54 || feelsLike >= 81
            ? 75
            : feelsLike >= 55 && feelsLike <= 80
              ? 100
              : 70;
  const sensitivity = feelsLike >= 80 ? config.heatSensitivity : config.coldSensitivity;
  return adjustScoreForSensitivity(baseScore, sensitivity);
}

function precipitationScore(chance: number | null) {
  if (chance === null) return 75;
  if (chance <= 10) return 100;
  if (chance <= 25) return 82;
  if (chance <= 45) return 58;
  if (chance <= 65) return 35;
  return 12;
}

function windScore(
  speed: number | null,
  gust: number | null,
  activity: ActivityMode
) {
  const config = getActivityConfig(activity);
  const sustainedScore =
    speed === null
      ? 78
      : speed <= 6
        ? 100
        : speed <= 11
          ? 85
          : speed <= 17
            ? 62
            : speed <= 24
              ? 35
              : 12;

  const gustScore =
    gust === null
      ? 100
      : gust >= 50
        ? 5
        : gust >= 40
          ? config.gustSensitivity >= 4
            ? 12
            : 25
          : gust >= 30
            ? 38
            : gust >= 20
              ? 72
              : 100;

  return Math.min(
    adjustScoreForSensitivity(sustainedScore, config.windSensitivity),
    adjustScoreForSensitivity(gustScore, config.gustSensitivity)
  );
}

function humidityScore(
  dewpointF: number | null,
  relativeHumidityPercent: number | null,
  apparentTemperatureF: number | null,
  temperatureF: number | null,
  activity: ActivityMode
) {
  const config = getActivityConfig(activity);
  const temp = apparentTemperatureF ?? temperatureF;

  if (dewpointF !== null) {
    if (dewpointF >= 75) {
      if ((temp ?? 0) >= 90) return config.heatSensitivity >= 5 ? 18 : 28;
      return 32;
    }
    if (dewpointF >= 70) return config.heatSensitivity >= 5 ? 38 : 52;
    if (dewpointF >= 65) return 68;
    if (dewpointF >= 60) return 82;
    return 95;
  }

  if (relativeHumidityPercent !== null && temp !== null) {
    if (temp >= 90 && relativeHumidityPercent >= 70) {
      return config.heatSensitivity >= 5 ? 22 : 34;
    }
    if (temp >= 85 && relativeHumidityPercent >= 75) return 40;
    if (temp >= 80 && relativeHumidityPercent >= 65) return 65;
    return 88;
  }

  return adjustScoreForSensitivity(80, Math.max(2, config.heatSensitivity - 1));
}

function visibilityScore(visibilityMiles: number | null, activity: ActivityMode) {
  const config = getActivityConfig(activity);
  if (visibilityMiles === null) return 80;
  const baseScore =
    visibilityMiles <= 0.25
      ? 5
      : visibilityMiles < 1
        ? 20
        : visibilityMiles < 3
          ? 42
          : visibilityMiles < 6
            ? 72
            : 100;
  return adjustScoreForSensitivity(baseScore, config.visibilitySensitivity);
}

function alertPenalty(alerts: WeatherAlert[]) {
  if (!alerts.length) return 100;
  const severe = alerts.some((alert) =>
    ["Severe", "Extreme"].includes(alert.severity)
  );
  return severe ? 10 : 45;
}

function aqiScore(reading: AirQualityReading | null | undefined) {
  if (!reading) return 70;
  const aqi = reading.aqi;
  if (aqi <= 50) return 100;
  if (aqi <= 100) return 72;
  if (aqi <= 150) return 40;
  if (aqi <= 200) return 18;
  return 5;
}

function getAqiReason(reading: AirQualityReading | null | undefined) {
  if (!reading) return null;
  if (reading.aqi <= 50) return null;
  if (reading.aqi <= 100) return "moderate air quality";
  if (reading.aqi <= 150) return "air quality may affect sensitive groups";
  return "unhealthy air quality";
}

function hourHasAqiImpact(
  reading: AirQualityReading | null | undefined,
  reasons: string[],
  breakdown: HourlyScoreBreakdown
) {
  if (!reading) return false;

  if (reading.aqi > 50) {
    return true;
  }

  if (breakdown.aqi < 100) {
    return true;
  }

  return reasons.some((reason) => {
    const normalized = reason.toLowerCase();
    return normalized.includes("air quality") || normalized.includes("aqi");
  });
}

function getAqiCap(
  activity: ActivityMode,
  reading: AirQualityReading | null | undefined
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  if (!reading) {
    return { classificationCap: null, reasons: [] };
  }

  const reason = getAqiReason(reading);
  const sensitivity = getActivityConfig(activity).aqiSensitivity;

  if (reading.aqi >= 201) {
    return {
      classificationCap: "avoid",
      reasons: reason ? [reason] : []
    };
  }

  if (reading.aqi >= 151) {
    return {
      classificationCap: sensitivity >= 4 ? "avoid" : "caution",
      reasons: reason ? [reason] : []
    };
  }

  if (reading.aqi >= 101 && sensitivity >= 4) {
    return {
      classificationCap: "caution",
      reasons: reason ? [reason] : []
    };
  }

  return { classificationCap: null, reasons: reason && reading.aqi >= 101 ? [reason] : [] };
}

function getRainCap(
  activity: ActivityMode,
  precipitationChance: number | null
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  if (precipitationChance === null) {
    return { classificationCap: null, reasons: [] };
  }

  if (precipitationChance >= 80) {
    return {
      classificationCap: "avoid",
      reasons: ["very high precip chance"]
    };
  }

  if (getActivityConfig(activity).precipitationSensitivity >= 4 && precipitationChance >= 50) {
    return {
      classificationCap: "caution",
      reasons: ["precip likely limits outdoor plans"]
    };
  }

  if (precipitationChance >= 70) {
    return {
      classificationCap: "caution",
      reasons: ["high precip chance"]
    };
  }

  return { classificationCap: null, reasons: [] };
}

function getApparentTemperatureCap(
  activity: ActivityMode,
  apparentTemperatureF: number | null,
  temperatureF: number | null
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  const feelsLike = apparentTemperatureF ?? temperatureF;
  const config = getActivityConfig(activity);
  if (feelsLike === null) {
    return { classificationCap: null, reasons: [] };
  }

  if (feelsLike <= 10 || feelsLike >= 105) {
    return {
      classificationCap: "avoid",
      reasons: [feelsLike >= 105 ? "dangerous heat risk" : "dangerous cold risk"]
    };
  }

  if (feelsLike >= 100) {
    return {
      classificationCap: config.heatSensitivity >= 5 ? "avoid" : "caution",
      reasons: ["dangerous heat risk"]
    };
  }

  if (feelsLike <= 24) {
    return {
      classificationCap: config.coldSensitivity >= 5 ? "avoid" : "caution",
      reasons: ["dangerous cold risk"]
    };
  }

  if ((feelsLike >= 95 && config.heatSensitivity >= 5) || feelsLike <= 34) {
    return {
      classificationCap: "caution",
      reasons: [feelsLike >= 95 ? "dangerous heat risk" : "dangerous cold risk"]
    };
  }

  return { classificationCap: null, reasons: [] };
}

function getWindGustCap(
  activity: ActivityMode,
  windGustMph: number | null
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  if (windGustMph === null) {
    return { classificationCap: null, reasons: [] };
  }

  if (windGustMph >= 50) {
    return {
      classificationCap: "avoid",
      reasons: [`dangerous wind gusts near ${windGustMph} mph`]
    };
  }

  if (windGustMph >= 40) {
    const config = getActivityConfig(activity);
    return {
      classificationCap: config.gustSensitivity >= 5 ? "avoid" : "caution",
      reasons: [`gusty winds near ${windGustMph} mph`]
    };
  }

  if (windGustMph >= 30) {
    if (getActivityConfig(activity).gustSensitivity < 4) {
      return { classificationCap: null, reasons: [] };
    }
    return {
      classificationCap: "caution",
      reasons: [`gusty winds near ${windGustMph} mph`]
    };
  }

  return { classificationCap: null, reasons: [] };
}

function getHumidityCap(
  activity: ActivityMode,
  dewpointF: number | null,
  apparentTemperatureF: number | null,
  temperatureF: number | null,
  relativeHumidityPercent: number | null
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  const feelsLike = apparentTemperatureF ?? temperatureF;
  const config = getActivityConfig(activity);

  if (dewpointF !== null) {
    if (dewpointF >= 75 && (feelsLike ?? 0) >= 90) {
      return {
        classificationCap: "caution",
        reasons: ["oppressive humidity"]
      };
    }

    if (dewpointF >= 70 && config.heatSensitivity >= 5) {
      return {
        classificationCap: "caution",
        reasons: ["humid air may make it feel worse"]
      };
    }
  }

  if (
    relativeHumidityPercent !== null &&
    feelsLike !== null &&
    feelsLike >= 85 &&
    relativeHumidityPercent >= 75
  ) {
    return {
      classificationCap: "caution",
      reasons: ["humid air may make it feel worse"]
    };
  }

  return { classificationCap: null, reasons: [] };
}

function getVisibilityCap(
  activity: ActivityMode,
  visibilityMiles: number | null
): {
  classificationCap: "caution" | "avoid" | null;
  reasons: string[];
} {
  if (visibilityMiles === null) {
    return { classificationCap: null, reasons: [] };
  }

  if (visibilityMiles <= 0.25) {
    return {
      classificationCap: "avoid",
      reasons: [`reduced visibility around ${visibilityMiles} miles`]
    };
  }

  if (visibilityMiles < 1) {
    return {
      classificationCap: "avoid",
      reasons: [`reduced visibility around ${visibilityMiles} miles`]
    };
  }

  if (visibilityMiles < 3) {
    if (getActivityConfig(activity).visibilitySensitivity < 3) {
      return { classificationCap: null, reasons: [] };
    }
    return {
      classificationCap: "caution",
      reasons: [`reduced visibility around ${visibilityMiles} miles`]
    };
  }

  return { classificationCap: null, reasons: [] };
}

function normalizeAlertEvent(event: string) {
  return event.trim().toLowerCase();
}

function getAlertReason(alert: WeatherAlert) {
  const event = normalizeAlertEvent(alert.event);

  if (event === "tornado warning") return "Active tornado warning";
  if (event === "tornado watch") return "Active tornado watch";
  if (event === "severe thunderstorm warning") {
    return "Severe thunderstorm warning in effect";
  }
  if (event === "flash flood warning") return "Flash flood warning in effect";
  if (event === "extreme wind warning") return "Extreme wind warning in effect";
  if (event === "severe thunderstorm watch") {
    return "Severe thunderstorm watch in effect";
  }
  if (event === "flood watch") return "Flood watch in effect";
  if (event === "heat advisory") return "Heat advisory in effect";
  if (event === "ice storm warning") return "Ice storm warning in effect";
  if (event === "winter storm warning") return "Winter storm warning in effect";
  if (event === "blizzard warning") return "Blizzard warning in effect";
  if (event === "excessive heat warning") return "Excessive heat warning in effect";
  if (event === "extreme cold warning") return "Extreme cold warning in effect";
  if (event === "wind chill warning") return "Wind chill warning in effect";
  if (event === "winter weather advisory") return "Winter weather advisory in effect";

  return `${alert.event} in effect`;
}

function isAlertActiveForHour(alert: WeatherAlert, hour: ForecastHour) {
  const hourStart = new Date(hour.startTime).getTime();
  const hourEnd = new Date(hour.endTime).getTime();
  const onset = alert.onset ? new Date(alert.onset).getTime() : null;
  const ends = alert.ends ? new Date(alert.ends).getTime() : null;

  if (onset && onset > hourEnd) return false;
  if (ends && ends < hourStart) return false;
  return true;
}

function getPostAlertState(alert: WeatherAlert, hour: ForecastHour) {
  const event = normalizeAlertEvent(alert.event);
  if (!alert.ends) return null;

  const endTime = new Date(alert.ends).getTime();
  const hourStart = new Date(hour.startTime).getTime();

  if (hourStart < endTime) return null;

  if (severeWarningEvents.has(event) && hourStart < endTime + 2 * 60 * 60 * 1000) {
    return {
      alertImpact: "moderate" as const,
      classificationCap: "caution" as const,
      reason: "recent severe alert nearby",
      label: "recent alert",
      context: "recent-alert" as const
    };
  }

  if (watchAlertEvents.has(event) && hourStart < endTime + 60 * 60 * 1000) {
    return {
      alertImpact: "moderate" as const,
      classificationCap: "caution" as const,
      reason: "recent severe watch",
      label: "recent watch",
      context: "recent-watch" as const
    };
  }

  return null;
}

function getAlertStateForHour(
  alerts: WeatherAlert[],
  hour: ForecastHour,
  activity: ActivityMode
) {
  let activeAlertImpact: AlertImpactLevel = "none";
  let recentAlertImpact: "none" | "moderate" = "none";
  let classificationCap: "caution" | "avoid" | null = null;
  const reasons: string[] = [];
  let label: string | undefined;
  let context: "active-alert" | "recent-alert" | "recent-watch" | null = null;
  const activeAlerts: WeatherAlert[] = [];

  for (const alert of alerts) {
    const event = normalizeAlertEvent(alert.event);
    const isActive = isAlertActiveForHour(alert, hour);

    if (isActive) {
      activeAlerts.push(alert);
      const reason = getAlertReason(alert);
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }

      if (severeWarningEvents.has(event)) {
        activeAlertImpact = "severe";
        classificationCap = "avoid";
        label = "alert";
        context = "active-alert";
      } else if (watchAlertEvents.has(event) || moderateAlertEvents.has(event)) {
        if (activeAlertImpact !== "severe") {
          activeAlertImpact = "moderate";
          const config = getActivityConfig(activity);
          classificationCap =
            event === "heat advisory" &&
            config.heatSensitivity >= 5 &&
            hour.temperatureF !== null &&
            hour.temperatureF >= 90
              ? "avoid"
              : "caution";
        }
        label = "alert";
        context = "active-alert";
      }
      continue;
    }

    const postAlert = getPostAlertState(alert, hour);
    if (!postAlert) continue;

    if (!reasons.includes(postAlert.reason)) {
      reasons.push(postAlert.reason);
    }
    if (activeAlertImpact === "none") {
      recentAlertImpact = postAlert.alertImpact;
      classificationCap = postAlert.classificationCap;
      label = postAlert.label;
      context = postAlert.context;
    }
  }

  const combinedAlertImpact: AlertImpactLevel =
    activeAlertImpact === "severe"
      ? "severe"
      : activeAlertImpact === "moderate" || recentAlertImpact === "moderate"
        ? "moderate"
        : "none";

  return {
    alertImpact: combinedAlertImpact,
    activeAlertImpact,
    recentAlertImpact,
    classificationCap,
    reasons,
    label,
    context,
    activeAlerts
  };
}

function relevantAlertsForHour(alerts: WeatherAlert[], hour: ForecastHour) {
  return alerts.filter((alert) => isAlertActiveForHour(alert, hour));
}

function buildReasons(
  forecast: ForecastHour,
  breakdown: HourlyScoreBreakdown,
  airQuality: AirQualityReading | null | undefined,
  alertsForHour: WeatherAlert[],
  alertImpact: AlertImpactLevel,
  extraAlertReasons: string[],
  precipLabel: string
) {
  const reasons: string[] = [];
  const feelsLike = forecast.apparentTemperatureF ?? forecast.temperatureF;
  const pushReason = (reason: string) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  for (const extraReason of extraAlertReasons) {
    pushReason(extraReason);
  }

  const hasSpecificAlertReason = reasons.some((reason) => {
    const normalized = reason.toLowerCase();
    return (
      normalized.includes(" warning") ||
      normalized.includes(" watch") ||
      normalized.endsWith(" in effect") ||
      normalized.startsWith("active tornado")
    );
  });

  if (
    alertImpact === "severe" &&
    !reasons.includes("active severe weather alert") &&
    !hasSpecificAlertReason
  ) {
    reasons.unshift("active severe weather alert");
  }

  if (breakdown.comfort >= 85 && feelsLike !== null) {
    pushReason(`comfortable around ${feelsLike}F`);
  } else if (feelsLike !== null && breakdown.comfort <= 75) {
    pushReason(`feels like ${feelsLike}F`);
  }

  if (breakdown.precipitation >= 80) {
    pushReason("low precip risk");
  } else if (forecast.precipitationChance !== null && breakdown.precipitation <= 40) {
    pushReason(
      precipLabel.endsWith("possible")
        ? `${forecast.precipitationChance}% ${precipLabel}`
        : `${forecast.precipitationChance}% ${precipLabel} chance`
    );
  }

  if (forecast.windGustMph !== null && forecast.windGustMph >= 50) {
    pushReason(`dangerous wind gusts near ${forecast.windGustMph} mph`);
  } else if (forecast.windGustMph !== null && forecast.windGustMph >= 20) {
    pushReason(`gusty winds near ${forecast.windGustMph} mph`);
  } else if (breakdown.wind >= 80 && forecast.windSpeedMph !== null) {
    pushReason(`lighter wind near ${forecast.windSpeedMph} mph`);
  } else if (forecast.windSpeedMph !== null && breakdown.wind <= 40) {
    pushReason(`wind picks up near ${forecast.windSpeedMph} mph`);
  }

  if (breakdown.humidity <= 35) {
    pushReason("oppressive humidity");
  } else if (breakdown.humidity <= 60) {
    pushReason("humid air may make it feel worse");
  }

  if (forecast.visibilityMiles !== null && breakdown.visibility <= 60) {
    pushReason(`reduced visibility around ${forecast.visibilityMiles} miles`);
  }

  if (airQuality) {
    const aqiReason = getAqiReason(airQuality);
    if (aqiReason) {
      pushReason(aqiReason);
    }
  }

  if (alertsForHour.length) {
    for (const alert of alertsForHour) {
      const reason = getAlertReason(alert);
      pushReason(reason);
    }
  }

  const hasLimitingReason = reasons.some((reason) =>
    [
      "storm",
      "flood",
      "ice",
      "snow",
      "warning",
      "watch",
      "precip",
      "wind",
      "visibility",
      "humidity",
      "aqi",
      "air quality",
      "feels like"
    ].some((keyword) => reason.toLowerCase().includes(keyword))
  );

  if (!hasLimitingReason) {
    const limitingCandidates: Array<{ score: number; reason: string }> = [];

    if (forecast.precipitationChance !== null && breakdown.precipitation < 80) {
      limitingCandidates.push({
        score: breakdown.precipitation,
        reason: precipLabel.endsWith("possible")
          ? `${forecast.precipitationChance}% ${precipLabel}`
          : `${forecast.precipitationChance}% ${precipLabel} chance`
      });
    }

    if (forecast.windGustMph !== null && forecast.windGustMph >= 20) {
      limitingCandidates.push({
        score: breakdown.wind,
        reason:
          forecast.windGustMph >= 50
            ? `dangerous wind gusts near ${forecast.windGustMph} mph`
            : `gusty winds near ${forecast.windGustMph} mph`
      });
    } else if (forecast.windSpeedMph !== null && breakdown.wind < 80) {
      limitingCandidates.push({
        score: breakdown.wind,
        reason: `wind picks up near ${forecast.windSpeedMph} mph`
      });
    }

    if (forecast.visibilityMiles !== null && breakdown.visibility < 80) {
      limitingCandidates.push({
        score: breakdown.visibility,
        reason: `reduced visibility around ${forecast.visibilityMiles} miles`
      });
    }

    if (breakdown.humidity < 80) {
      limitingCandidates.push({
        score: breakdown.humidity,
        reason: breakdown.humidity <= 35
          ? "oppressive humidity"
          : "humid air may make it feel worse"
      });
    }

    if (airQuality && breakdown.aqi < 80) {
      limitingCandidates.push({
        score: breakdown.aqi,
        reason:
          getAqiReason(airQuality) ??
          `AQI ${airQuality.aqi}: ${getAqiMeaning(airQuality.aqi).toLowerCase()}`
      });
    }

    if (feelsLike !== null && breakdown.comfort <= 75) {
      limitingCandidates.push({
        score: breakdown.comfort,
        reason: `feels like ${feelsLike}F`
      });
    }

    limitingCandidates.sort((a, b) => a.score - b.score);
    if (limitingCandidates[0]) {
      pushReason(limitingCandidates[0].reason);
    }
  }

  return reasons.slice(0, 4);
}

export function scoreForecastHours(params: {
  hours: ForecastHour[];
  alerts: WeatherAlert[];
  airQuality: AirQualityReading | null;
  airQualityByHour?: Map<string, AirQualityReading | null>;
  activity: ActivityMode;
  timeZone?: string;
}) {
  const {
    hours,
    alerts,
    airQuality,
    airQualityByHour,
    activity,
    timeZone = "UTC"
  } = params;
  const weights = getActivityWeights(activity);

  return hours.map((forecast): ScoredHour => {
    const hourlyAirQuality =
      airQualityByHour?.get(getZonedLocalHourKey(forecast.startTime, timeZone)) ??
      airQuality;
    const alertsForHour = relevantAlertsForHour(alerts, forecast);
    const alertState = getAlertStateForHour(alerts, forecast, activity);
    const breakdown: HourlyScoreBreakdown = {
      comfort: comfortScore(
        forecast.apparentTemperatureF,
        forecast.temperatureF,
        activity
      ),
      precipitation: precipitationScore(forecast.precipitationChance),
      wind: windScore(forecast.windSpeedMph, forecast.windGustMph, activity),
      humidity: humidityScore(
        forecast.dewpointF,
        forecast.relativeHumidityPercent,
        forecast.apparentTemperatureF,
        forecast.temperatureF,
        activity
      ),
      visibility: visibilityScore(forecast.visibilityMiles, activity),
      alerts: alertPenalty(alertsForHour),
      aqi: aqiScore(hourlyAirQuality)
    };
    const detailedText = forecast.detailedForecast ?? "";
    const relevantDetailedText = getRelevantForecastTextForHour(
      forecast,
      detailedText,
      timeZone
    );
    const hazardText = [forecast.shortForecast, relevantDetailedText]
      .filter(Boolean)
      .join(" ");
    const forecastHazards = detectForecastHazards(hazardText);
    const precipLabel = getHourlyPrecipLabel(
      forecast,
      detailedText,
      timeZone
    );
    const forecastHazardCap = getForecastHazardCap({
      hazards: forecastHazards,
      activity,
      temperatureF: forecast.apparentTemperatureF ?? forecast.temperatureF,
      visibilityMiles: forecast.visibilityMiles,
      aqi: hourlyAirQuality?.aqi ?? null
    });
    const apparentTemperatureCap = getApparentTemperatureCap(
      activity,
      forecast.apparentTemperatureF,
      forecast.temperatureF
    );
    const gustCap = getWindGustCap(activity, forecast.windGustMph);
    const humidityCap = getHumidityCap(
      activity,
      forecast.dewpointF,
      forecast.apparentTemperatureF,
      forecast.temperatureF,
      forecast.relativeHumidityPercent
    );
    const visibilityCap = getVisibilityCap(activity, forecast.visibilityMiles);
    const aqiCap = getAqiCap(activity, hourlyAirQuality);
    const rawScore =
      breakdown.comfort * weights.comfort +
      breakdown.precipitation * weights.precipitation +
      breakdown.wind * weights.wind +
      breakdown.humidity * weights.humidity +
      breakdown.visibility * weights.visibility +
      breakdown.alerts * weights.alerts +
      breakdown.aqi * weights.aqi;
    const rainCap = getRainCap(activity, forecast.precipitationChance);

    let score = Math.round(
      clamp(rawScore - forecastHazardCap.strongPenalty, 0, 100)
    );

    if (alertState.classificationCap === "avoid") {
      score = Math.min(score, 20);
    } else if (alertState.classificationCap === "caution") {
      score = Math.min(score, 40);
    }

    if (forecastHazardCap.classificationCap === "avoid") {
      score = Math.min(score, 20);
    } else if (forecastHazardCap.classificationCap === "caution") {
      score = Math.min(score, 40);
    }

    if (rainCap.classificationCap === "avoid") {
      score = Math.min(score, 20);
    } else if (rainCap.classificationCap === "caution") {
      score = Math.min(score, 40);
    }

    for (const cap of [
      apparentTemperatureCap,
      gustCap,
      humidityCap,
      visibilityCap,
      aqiCap
    ]) {
      if (cap.classificationCap === "avoid") {
        score = Math.min(score, 20);
      } else if (cap.classificationCap === "caution") {
        score = Math.min(score, 40);
      }
    }

    score = Math.round(clamp(score, 0, 100));
    const classification = classifyScore(score);

    const reasons = buildReasons(
      forecast,
      breakdown,
      hourlyAirQuality,
      alertsForHour,
      alertState.alertImpact,
      [
        ...alertState.reasons,
        ...forecastHazardCap.reasons,
        ...rainCap.reasons,
        ...apparentTemperatureCap.reasons,
        ...gustCap.reasons,
        ...humidityCap.reasons,
        ...visibilityCap.reasons,
        ...aqiCap.reasons
      ],
      precipLabel
    );
    const forecastWithAirQuality: ForecastHour = {
      ...forecast,
      aqi: hourlyAirQuality?.aqi ?? null,
      aqiCategory: hourlyAirQuality?.category ?? null
    };

    return {
      forecast: forecastWithAirQuality,
      score,
      classification,
      rating: deriveWindowRating(score),
      reasons,
      breakdown,
      airQuality: hourlyAirQuality,
      hasAqiImpact: hourHasAqiImpact(hourlyAirQuality, reasons, breakdown),
      hasRelevantAlert: alertsForHour.length > 0 || alertState.reasons.length > 0,
      alertImpact: alertState.alertImpact,
      activeAlertImpact: alertState.activeAlertImpact,
      recentAlertImpact: alertState.recentAlertImpact,
      alertLabel: alertState.label,
      alertContext: alertState.context
    };
  });
}

export function getSevereRiskSummaryAlerts(alerts: WeatherAlert[]) {
  return alerts.filter((alert) => severeRiskSummaryEvents.has(normalizeAlertEvent(alert.event)));
}
