import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSummary } from "@/lib/decisionSummary";
import { buildEventSummary, resolveEventWindow, scorePlannedEvent } from "@/lib/eventPlanning";
import { getActivityConfig } from "@/lib/activityConfig";
import { AirQualityPanel } from "@/components/AirQualityPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { HourlyTimeline } from "@/components/HourlyTimeline";
import { RecommendationCard } from "@/components/RecommendationCard";
import { WhyPanel } from "@/components/WhyPanel";
import {
  getDaylightWindowTier,
  getDaylightOverlapRatio,
  getSunTimesForDate,
  isMostlyDaylightWindow
} from "@/lib/daylight";
import { getHourlyPrecipLabel } from "@/lib/forecastHazards";
import { filterForecastHoursForHorizon } from "@/lib/horizon";
import { resolveLocationQuery } from "@/lib/locationLookup";
import {
  getOpenMeteoAqiCategory,
  matchAirQualityToForecastHours,
  normalizeOpenMeteoAirQuality
} from "@/lib/openMeteoAirQuality";
import { shouldRevealResults } from "@/lib/resultsFocus";
import { scoreForecastHours } from "@/lib/scoring";
import {
  classifyScore,
  deriveWindowRating,
  mergeHoursIntoWindows,
  selectBestWindows
} from "@/lib/timeWindows";
import { AirQualityReading, ForecastHour, WeatherAlert } from "@/lib/types";
import { titleCase } from "@/lib/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const testTimeZone = "America/Los_Angeles";

afterEach(() => {
  vi.restoreAllMocks();
});

function buildHour(overrides: Partial<ForecastHour>): ForecastHour {
  return {
    startTime: "2026-04-24T09:00:00-07:00",
    endTime: "2026-04-24T10:00:00-07:00",
    temperatureF: 68,
    apparentTemperatureF: null,
    temperatureUnit: "F",
    windSpeedMph: 5,
    windGustMph: null,
    windDirection: "NW",
    shortForecast: "Clear",
    detailedForecast: "Clear.",
    precipitationChance: 5,
    humidity: 55,
    relativeHumidityPercent: 55,
    dewpointF: null,
    visibilityMiles: null,
    fogMentioned: false,
    smokeMentioned: false,
    isDaytime: true,
    ...overrides
  };
}

describe("weather window scoring rules", () => {
  it("maps score thresholds to the correct labels", () => {
    expect(classifyScore(12)).toBe("avoid");
    expect(deriveWindowRating(12)).toBe("Avoid");
    expect(classifyScore(4)).toBe("avoid");
    expect(deriveWindowRating(4)).toBe("Avoid");
    expect(classifyScore(40)).toBe("caution");
    expect(deriveWindowRating(40)).toBe("Caution");
    expect(classifyScore(80)).toBe("good");
    expect(deriveWindowRating(80)).toBe("Good");
  });

  it("marks an active severe thunderstorm warning hour as avoid", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "warning-active",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T17:30:00-07:00",
          ends: "2026-04-24T19:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.activeAlertImpact).toBe("severe");
  });

  it("keeps timeline score labels aligned with the final score", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              startTime: "2026-04-24T18:00:00-07:00",
              endTime: "2026-04-24T19:00:00-07:00"
            }),
            score: 12,
            classification: classifyScore(12),
            rating: deriveWindowRating(12),
            reasons: ["active severe weather alert"],
            breakdown: {
              comfort: 90,
              precipitation: 90,
              wind: 90,
              humidity: 90,
              visibility: 90,
              alerts: 10,
              aqi: 90
            },
            airQuality: null,
            hasRelevantAlert: true,
            alertImpact: "severe",
            activeAlertImpact: "severe",
            recentAlertImpact: "none",
            alertLabel: "alert",
            alertContext: "active-alert"
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain(">12<");
    expect(markup).toContain(">avoid<");
  });

  it("marks an active tornado watch hour as caution", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "watch-active",
          event: "Tornado Watch",
          severity: "Severe",
          headline: "Tornado watch",
          description: "Conditions are favorable.",
          onset: "2026-04-24T16:00:00-07:00",
          ends: "2026-04-24T21:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.activeAlertImpact).toBe("moderate");
  });

  it("caps thunderstorms likely at caution", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely in the afternoon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.reasons).toContain("thunderstorms possible");
  });

  it("uses the fallback main factor instead of comfort when no good window exists", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely in the afternoon.",
          temperatureF: 70
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely in the afternoon.",
          temperatureF: 71
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "study"
    );

    expect(summary.messageType).toBe("fallback");
    expect(summary.mainFactor).toBe("limited but usable conditions");
  });

  it("adds a concise flexible insight before thunderstorms return", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Clear"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Clear"
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Chance of T-storms",
          detailedForecast: "Thunderstorms possible late morning.",
          precipitationChance: 70
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "walking"
    });
    const selected = selectBestWindows(mergeHoursIntoWindows(hours), hours, "24h", testTimeZone);
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "walking"
    );

    expect(summary.highlightInsight).toContain("Best window ends before thunderstorms return");
    expect(summary.highlightInsight?.split(".").filter(Boolean).length).toBe(1);
  });

  it("treats severe storm wording as avoid-level risk", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Chance of storms",
          detailedForecast: "Some storms could be severe with damaging winds."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("severe storms possible");
  });

  it("forces avoid when tornadoes are mentioned", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          detailedForecast: "Tornadoes possible with evening storms."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("tornado risk mentioned");
  });

  it("forces avoid for freezing rain risk", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Wintry mix",
          detailedForecast: "Freezing rain likely before noon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("ice or freezing rain risk");
  });

  it("caps snow showers at caution", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Snow showers",
          detailedForecast: "Snow showers through the afternoon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.reasons).toContain("snow may affect conditions");
  });

  it("forces avoid for heavy snow wording", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Heavy snow",
          detailedForecast: "Heavy snow with accumulating snow this evening."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("snow may affect conditions");
  });

  it("forces avoid for heavy rain and flooding wording", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Heavy rain",
          detailedForecast: "Heavy rain and flooding possible overnight."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("heavy rain or flooding risk");
  });

  it("forces avoid for excessive heat warning", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 101,
          apparentTemperatureF: 106
        })
      ],
      alerts: [
        {
          id: "heat-warning",
          event: "Excessive Heat Warning",
          severity: "Extreme",
          headline: "Excessive heat warning",
          description: "Dangerous heat.",
          onset: "2026-04-24T08:00:00-07:00",
          ends: "2026-04-24T20:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.activeAlertImpact).toBe("severe");
  });

  it("forces avoid for extreme cold warning", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 8,
          apparentTemperatureF: 5
        })
      ],
      alerts: [
        {
          id: "cold-warning",
          event: "Extreme Cold Warning",
          severity: "Extreme",
          headline: "Extreme cold warning",
          description: "Dangerous cold.",
          onset: "2026-04-24T00:00:00-07:00",
          ends: "2026-04-24T12:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.activeAlertImpact).toBe("severe");
  });

  it("treats apparent temperature near 100F as avoid-level for exercise", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 90,
          apparentTemperatureF: 100
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
  });

  it("forces avoid for all modes when apparent temperature reaches 105F", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 96,
          apparentTemperatureF: 105
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.score).toBeLessThan(40);
  });

  it("caps comfortable high-rain hours at avoid", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00",
          temperatureF: 70,
          apparentTemperatureF: 70,
          precipitationChance: 80
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.rating).toBe("Avoid");
    expect(hour.score).toBeLessThanOrEqual(20);
    expect(hour.reasons).toContain("very high precip chance");
  });

  it("gusts near 40 mph prevent a good rating", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          windGustMph: 42
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).not.toBe("good");
    expect(hour.reasons).toContain("gusty winds near 42 mph");
  });

  it("gusts near 50 mph force avoid", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          windGustMph: 52
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("dangerous wind gusts near 52 mph");
  });

  it("dew point above 70F penalizes exercise", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 84,
          apparentTemperatureF: 86,
          dewpointF: 72
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.reasons).toContain("humid air may make it feel worse");
  });

  it("oppressive humidity plus heat prevents a good rating", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 91,
          apparentTemperatureF: 97,
          dewpointF: 76
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).not.toBe("good");
    expect(hour.reasons).toContain("oppressive humidity");
  });

  it("very low visibility prevents a good rating", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          visibilityMiles: 0.6
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("reduced visibility around 0.6 miles");
  });

  it("detects dense fog as a visibility hazard", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Dense fog",
          detailedForecast: "Dense fog before sunrise.",
          visibilityMiles: 0.5
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("avoid");
    expect(hour.reasons).toContain("fog may reduce visibility");
  });

  it("adds smoke caution from forecast text", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Areas of smoke",
          detailedForecast: "Areas of smoke and haze this afternoon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.reasons).toContain("smoke may affect air quality");
  });

  it("treats missing new fields as neutral without crashing", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          apparentTemperatureF: null,
          windGustMph: null,
          relativeHumidityPercent: null,
          dewpointF: null,
          visibilityMiles: null,
          fogMentioned: false,
          smokeMentioned: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.score).toBeGreaterThan(0);
    expect(hour.classification).toBe("good");
  });

  it("returns no Today hours when only after-8 PM options remain", () => {
    const now = new Date("2026-04-24T19:35:00-07:00");
    const filtered = filterForecastHoursForHorizon(
      [
        buildHour({
          startTime: "2026-04-24T20:00:00-07:00",
          endTime: "2026-04-24T21:00:00-07:00",
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-04-24T21:00:00-07:00",
          endTime: "2026-04-24T22:00:00-07:00",
          isDaytime: false
        })
      ],
      "today",
      testTimeZone,
      now
    );

    expect(filtered).toHaveLength(0);
  });

  it("prefers non-buffer windows over post-alert buffer hours", () => {
    const hours = [
      buildHour({
        startTime: "2026-04-24T10:00:00-07:00",
        endTime: "2026-04-24T11:00:00-07:00",
        temperatureF: 73,
        apparentTemperatureF: 73,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T11:00:00-07:00",
        endTime: "2026-04-24T12:00:00-07:00",
        temperatureF: 72,
        apparentTemperatureF: 72,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T12:00:00-07:00",
        endTime: "2026-04-24T13:00:00-07:00",
        temperatureF: 69,
        apparentTemperatureF: 69,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T13:00:00-07:00",
        endTime: "2026-04-24T14:00:00-07:00",
        temperatureF: 68,
        apparentTemperatureF: 68,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T14:00:00-07:00",
        endTime: "2026-04-24T15:00:00-07:00",
        temperatureF: 67,
        apparentTemperatureF: 67,
        precipitationChance: 5
      })
    ];

    const alerts: WeatherAlert[] = [
      {
        id: "warning-1",
        event: "Severe Thunderstorm Warning",
        severity: "Severe",
        headline: "Severe thunderstorm warning",
        description: "Storms nearby.",
        onset: "2026-04-24T08:30:00-07:00",
        ends: "2026-04-24T10:30:00-07:00"
      }
    ];

    const scored = scoreForecastHours({
      hours,
      alerts,
      airQuality: null,
      activity: "social"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(scored),
      scored,
      "24h",
      testTimeZone
    );

    expect(scored[1].alertContext).toBe("recent-alert");
    expect(scored[2].alertContext).toBe("recent-alert");
    expect(selected.bestWindow).not.toBeNull();
    expect(selected.bestWindow?.startTime).toBe("2026-04-24T13:00:00-07:00");
    expect(
      selected.bestWindow?.hours.some((hour) => hour.alertContext === "recent-alert")
    ).toBe(false);
  });

  it("keeps two hours after warning expiration at caution", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T12:00:00-07:00",
          endTime: "2026-04-24T13:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "warning-buffer",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T08:30:00-07:00",
          ends: "2026-04-24T10:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("caution");
    expect(hour.recentAlertImpact).toBe("moderate");
  });

  it("scores seven to ten hours after warning expiration normally", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00",
          temperatureF: 67,
          apparentTemperatureF: 67,
          precipitationChance: 5
        })
      ],
      alerts: [
        {
          id: "warning-expired",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T08:30:00-07:00",
          ends: "2026-04-24T10:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.classification).toBe("good");
    expect(hour.recentAlertImpact).toBe("none");
  });

  it("scores the next morning normally after an evening watch expires", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-25T07:00:00-07:00",
          endTime: "2026-04-25T08:00:00-07:00",
          temperatureF: 61,
          apparentTemperatureF: 61,
          precipitationChance: 5
        })
      ],
      alerts: [
        {
          id: "watch-expired",
          event: "Tornado Watch",
          severity: "Severe",
          headline: "Tornado watch",
          description: "Conditions are favorable.",
          onset: "2026-04-24T14:00:00-07:00",
          ends: "2026-04-24T21:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social"
    });

    expect(hour.classification).toBe("good");
    expect(hour.activeAlertImpact).toBe("none");
    expect(hour.recentAlertImpact).toBe("none");
  });

  it("keeps a low-risk day as a good recommended window", () => {
    const hours = [
      buildHour({
        startTime: "2026-04-24T08:00:00-07:00",
        endTime: "2026-04-24T09:00:00-07:00",
        temperatureF: 64,
        apparentTemperatureF: 64,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T09:00:00-07:00",
        endTime: "2026-04-24T10:00:00-07:00",
        temperatureF: 66,
        apparentTemperatureF: 66,
        precipitationChance: 5
      }),
      buildHour({
        startTime: "2026-04-24T10:00:00-07:00",
        endTime: "2026-04-24T11:00:00-07:00",
        temperatureF: 68,
        apparentTemperatureF: 68,
        precipitationChance: 10
      }),
      buildHour({
        startTime: "2026-04-24T11:00:00-07:00",
        endTime: "2026-04-24T12:00:00-07:00",
        temperatureF: 69,
        apparentTemperatureF: 69,
        precipitationChance: 10
      })
    ];

    const scored = scoreForecastHours({
      hours,
      alerts: [],
      airQuality: null,
      activity: "study"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(scored),
      scored,
      "24h",
      testTimeZone
    );

    expect(selected.bestWindow).not.toBeNull();
    expect(selected.bestWindow?.rating).toBe("Good");
    expect(selected.bestWindow?.classification).toBe("good");
  });

  it("moves future-risk context into the context note when severe storm wording appears later", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T14:00:00-07:00",
          endTime: "2026-04-24T15:00:00-07:00",
          shortForecast: "Chance of storms",
          detailedForecast: "Some storms could be severe later today."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const windows = mergeHoursIntoWindows(hours);
    const selected = selectBestWindows(windows, hours, "24h", testTimeZone);
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(selected.bestWindow?.rating).toBe("Good");
    expect(summary.contextNote).toBe("Thunderstorms may return later.");
  });

  it("uses Best available window for caution-rated recommendations", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely later this hour."
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely later this hour."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(summary.heading).toBe("Best available window");
  });

  it("uses the storm-blocked message when weather hazards remove all safe windows", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Tornadoes possible",
          detailedForecast: "Tornadoes possible with severe storms."
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Heavy rain",
          detailedForecast: "Heavy rain and flooding possible."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "exercise"
    });
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "exercise"
    );

    expect(summary.heading).toBe("No safe outdoor window due to weather");
    expect(summary.messageType).toBe("weather_blocked");
    expect(summary.mainFactor).toBe("storms or heavy precipitation limit outdoor plans");
  });

  it("uses the alert-blocked message when active warnings block the period", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-28T22:00:00-07:00",
          endTime: "2026-04-28T23:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-28T23:00:00-07:00",
          endTime: "2026-04-29T00:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "warning-block",
          event: "Tornado Warning",
          severity: "Extreme",
          headline: "Tornado warning",
          description: "Take shelter now.",
          onset: "2026-04-28T22:30:00-07:00",
          ends: "2026-04-29T00:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [
        {
          id: "warning-block",
          event: "Tornado Warning",
          severity: "Extreme",
          headline: "Tornado warning",
          description: "Take shelter now.",
          onset: "2026-04-28T22:30:00-07:00",
          ends: "2026-04-29T00:30:00-07:00"
        }
      ],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "exercise"
    );

    expect(summary.heading).toBe("Outdoor conditions are not safe due to active warnings");
    expect(summary.messageType).toBe("alert_blocked");
    expect(summary.mainFactor).toBe("active weather warnings");
    expect(summary.contextNote).toBe("Active warning in effect. Follow official instructions.");
  });

  it("shows the Today is nearly over state when fewer than 2 useful hours remain", () => {
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: [],
        nextAvailableWindow: null
      },
      "today",
      testTimeZone,
      "social",
      {
        todayNearlyOver: true
      }
    );

    expect(summary.heading).toBe("Today is nearly over");
    expect(summary.messageType).toBe("time_limited");
    expect(summary.explanation).toBe(
      "Not enough time left today for a reliable window. Try Tonight or Next 24 hours."
    );
    expect(summary.mainFactor).toBe("limited remaining time today");
    expect(summary.explanation.toLowerCase()).not.toContain("unsafe");
  });

  it("uses weather-blocked messaging instead of time-limited when hazards are the real blocker", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through the evening."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "today",
      testTimeZone,
      "social",
      {
        todayNearlyOver: true
      }
    );

    expect(summary.heading).toBe("No safe outdoor window due to weather");
    expect(summary.messageType).toBe("weather_blocked");
    expect(summary.mainFactor).toBe("storms or heavy precipitation limit outdoor plans");
  });

  it("does not use time_limited for a stormy mid-afternoon Today result", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T15:00:00-07:00",
          endTime: "2026-04-24T16:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through the afternoon.",
          precipitationChance: 80
        }),
        buildHour({
          startTime: "2026-04-24T16:00:00-07:00",
          endTime: "2026-04-24T17:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through the afternoon.",
          precipitationChance: 80
        }),
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through the afternoon.",
          precipitationChance: 80
        }),
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through the afternoon.",
          precipitationChance: 80
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "today",
      testTimeZone,
      "social",
      {
        todayNearlyOver: false
      }
    );

    expect(summary.messageType).toBe("weather_blocked");
    expect(summary.heading).toBe("No safe outdoor window due to weather");
    expect(summary.mainFactor).toBe("storms or heavy precipitation limit outdoor plans");
  });

  it("after 8 PM Today with little time left shows time_limited", () => {
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: [
          {
            forecast: buildHour({
              startTime: "2026-04-24T20:00:00-07:00",
              endTime: "2026-04-24T21:00:00-07:00"
            }),
            score: 85,
            classification: "good",
            rating: "Good",
            reasons: ["comfortable around 68F"],
            breakdown: {
              comfort: 100,
              precipitation: 100,
              wind: 100,
              humidity: 90,
              visibility: 100,
              alerts: 100,
              aqi: 100
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none"
          }
        ],
        nextAvailableWindow: null
      },
      "today",
      testTimeZone,
      "walking",
      {
        todayNearlyOver: true
      }
    );

    expect(summary.messageType).toBe("time_limited");
    expect(summary.heading).toBe("Today is nearly over");
  });

  it("active warning overrides time_limited as the primary message", () => {
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [
          {
            id: "warning-block",
            event: "Tornado Warning",
            severity: "Extreme",
            headline: "Tornado warning",
            description: "Take shelter now.",
            onset: "2026-04-24T20:30:00-07:00",
            ends: "2099-04-24T21:30:00-07:00"
          }
        ],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: [
          {
            forecast: buildHour({
              startTime: "2026-04-24T20:00:00-07:00",
              endTime: "2026-04-24T21:00:00-07:00"
            }),
            score: 12,
            classification: "avoid",
            rating: "Avoid",
            reasons: ["active severe weather alert"],
            breakdown: {
              comfort: 90,
              precipitation: 90,
              wind: 90,
              humidity: 90,
              visibility: 90,
              alerts: 10,
              aqi: 90
            },
            airQuality: null,
            hasRelevantAlert: true,
            alertImpact: "severe",
            activeAlertImpact: "severe",
            recentAlertImpact: "none"
          }
        ],
        nextAvailableWindow: null
      },
      "today",
      testTimeZone,
      "walking",
      {
        todayNearlyOver: true
      }
    );

    expect(summary.messageType).toBe("alert_blocked");
    expect(summary.heading).toBe("Outdoor conditions are not safe due to active warnings");
    expect(summary.mainFactor).toBe("active weather warnings");
  });

  it("does not show Conditions stable when thunderstorms and a tornado watch exist", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely this afternoon."
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely this afternoon."
        })
      ],
      alerts: [
        {
          id: "watch",
          event: "Tornado Watch",
          severity: "Severe",
          headline: "Tornado watch",
          description: "Conditions are favorable.",
          onset: "2026-04-24T08:00:00-07:00",
          ends: "2026-04-24T20:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [
          {
            id: "watch",
            event: "Tornado Watch",
            severity: "Severe",
            headline: "Tornado watch",
            description: "Conditions are favorable.",
            onset: "2026-04-24T08:00:00-07:00",
            ends: "2026-04-24T20:00:00-07:00"
          }
        ],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(summary.riskTrend).toBeUndefined();
  });

  it("renders Avoid for no safe window states", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window unavailable in the selected timeframe.",
            heading: "No safe outdoor window due to weather",
            confidence: "Low",
            confidenceExplanation: "Some risk factors are present, but timing is fairly clear.",
            explanation: "Storm risk continues through this period.",
            messageType: "weather_blocked",
            contextNote: "Thunderstorms may return later.",
            mainFactor: "storms or heavy precipitation limit outdoor plans"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: {
            available: true
          },
          airQuality: {
            primary: null,
            available: false
          },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain(">Avoid<");
  });

  it("hides avoid secondary windows", () => {
    const goodHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const avoidHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00",
          shortForecast: "Heavy rain",
          detailedForecast: "Heavy rain and flooding possible."
        }),
        buildHour({
          startTime: "2026-04-24T12:00:00-07:00",
          endTime: "2026-04-24T13:00:00-07:00",
          shortForecast: "Heavy rain",
          detailedForecast: "Heavy rain and flooding possible."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const bestWindow = mergeHoursIntoWindows(goodHours)[0];
    const secondaryWindow = mergeHoursIntoWindows(avoidHours)[0];
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Fri, Apr 24 8:00 AM - 10:00 AM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Other green hours may still be available.",
            riskTrend: "Risk improves later",
            mainFactor: "comfortable around 68F"
          },
          bestWindow,
          secondaryWindow,
          nextAvailableWindow: null,
          cautionWindows: [],
          avoidWindows: [secondaryWindow],
          hourly: [...goodHours, ...avoidHours],
          alerts: [],
          alertsInfo: {
            available: true
          },
          airQuality: {
            primary: null,
            available: false
          },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).not.toContain("Secondary option");
  });

  it("renders the score legend with the correct ranges", () => {
    const scoredHour = {
      forecast: buildHour({}),
      score: 88,
      classification: "good" as const,
      rating: "Good" as const,
      reasons: ["comfortable around 68F"],
      breakdown: {
        comfort: 100,
        precipitation: 100,
        wind: 100,
        humidity: 80,
        visibility: 80,
        alerts: 100,
        aqi: 70
      },
      airQuality: null,
      hasRelevantAlert: false,
      alertImpact: "none" as const,
      activeAlertImpact: "none" as const,
      recentAlertImpact: "none" as const,
      alertContext: null
    };
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [scoredHour],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("Good: 80-100");
    expect(markup).toContain("Caution: 40-79");
    expect(markup).toContain("Avoid: 0-39");
  });

  it("does not use comfortable temperature as the main factor when gusts are limiting", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 70,
          apparentTemperatureF: 70,
          windGustMph: 34
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          temperatureF: 71,
          apparentTemperatureF: 71,
          windGustMph: 34
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(summary.mainFactor).toBe("gusty winds near 34 mph");
  });

  it("does not use comfortable temperature as the main factor when visibility is reduced", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 69,
          apparentTemperatureF: 69,
          visibilityMiles: 2.4
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          temperatureF: 70,
          apparentTemperatureF: 70,
          visibilityMiles: 2.4
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "study"
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(summary.mainFactor).toBe("reduced visibility around 2.4 miles");
  });

  it("removes duplicate rain reasons when rain is the main limiting factor", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          precipitationChance: 85,
          shortForecast: "Rain",
          detailedForecast: "Rain likely through the afternoon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(hour.reasons.filter((reason) => reason === "very high precip chance")).toHaveLength(1);
    expect(hour.reasons.filter((reason) => reason === "precip likely limits outdoor plans")).toHaveLength(0);
  });

  it("shows snow instead of rain for high PoP with snow text", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              precipitationChance: 90,
              temperatureF: 28,
              shortForecast: "Snow likely",
              detailedForecast: "Snow likely through the morning."
            }),
            score: 34,
            classification: "avoid" as const,
            rating: "Avoid" as const,
            reasons: ["snow may affect conditions"],
            breakdown: {
              comfort: 75,
              precipitation: 12,
              wind: 100,
              humidity: 80,
              visibility: 80,
              alerts: 100,
              aqi: 70
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none" as const,
            activeAlertImpact: "none" as const,
            recentAlertImpact: "none" as const,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("90% snow");
    expect(markup).not.toContain("90% rain");
  });

  it("shows freezing rain wording and forces avoid", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          precipitationChance: 80,
          temperatureF: 30,
          shortForecast: "Freezing rain",
          detailedForecast: "Freezing rain likely before noon."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [hour],
        timeZone: testTimeZone
      })
    );

    expect(hour.classification).toBe("avoid");
    expect(markup).toContain("80% ice/freezing rain");
  });

  it("does not label cold unknown precipitation as rain", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              precipitationChance: 70,
              temperatureF: 29,
              shortForecast: "Cloudy",
              detailedForecast: "Chance of precipitation overnight."
            }),
            score: 52,
            classification: "caution" as const,
            rating: "Caution" as const,
            reasons: ["70% precip chance"],
            breakdown: {
              comfort: 58,
              precipitation: 35,
              wind: 100,
              humidity: 80,
              visibility: 80,
              alerts: 100,
              aqi: 70
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none" as const,
            activeAlertImpact: "none" as const,
            recentAlertImpact: "none" as const,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("70% precip");
    expect(markup).not.toContain("70% rain");
  });

  it("shows T-storms instead of rain for thunderstorm wording", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              precipitationChance: 70,
              temperatureF: 74,
              shortForecast: "Thunderstorms likely",
              detailedForecast: "Thunderstorms likely this afternoon."
            }),
            score: 40,
            classification: "caution" as const,
            rating: "Caution" as const,
            reasons: ["thunderstorms possible"],
            breakdown: {
              comfort: 100,
              precipitation: 35,
              wind: 100,
              humidity: 80,
              visibility: 80,
              alerts: 100,
              aqi: 70
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none" as const,
            activeAlertImpact: "none" as const,
            recentAlertImpact: "none" as const,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("70% T-storms");
    expect(markup).not.toContain("70% rain");
  });

  it("keeps warm rain wording when rain is clearly indicated", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              precipitationChance: 60,
              temperatureF: 61,
              shortForecast: "Rain showers",
              detailedForecast: "Rain showers through the morning."
            }),
            score: 55,
            classification: "caution" as const,
            rating: "Caution" as const,
            reasons: ["60% rain chance"],
            breakdown: {
              comfort: 100,
              precipitation: 35,
              wind: 100,
              humidity: 80,
              visibility: 80,
              alerts: 100,
              aqi: 70
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none" as const,
            activeAlertImpact: "none" as const,
            recentAlertImpact: "none" as const,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("60% rain");
  });

  it("labels early hours as storms and later hours as snow from hour-specific short forecasts", () => {
    const earlyHour = buildHour({
      startTime: "2026-04-24T21:00:00-07:00",
      endTime: "2026-04-24T22:00:00-07:00",
      temperatureF: 45,
      shortForecast: "Rain and thunderstorms",
      detailedForecast: "Rain and thunderstorms before 10pm, then snow showers after midnight."
    });
    const lateHour = buildHour({
      startTime: "2026-04-25T01:00:00-07:00",
      endTime: "2026-04-25T02:00:00-07:00",
      temperatureF: 30,
      shortForecast: "Snow showers",
      detailedForecast: "Rain and thunderstorms before 10pm, then snow showers after midnight."
    });

    expect(getHourlyPrecipLabel(earlyHour, earlyHour.detailedForecast ?? "", testTimeZone)).toBe("T-storms");
    expect(getHourlyPrecipLabel(lateHour, lateHour.detailedForecast ?? "", testTimeZone)).toBe("snow");
  });

  it("labels rain and snow transition text by hour", () => {
    const eveningHour = buildHour({
      startTime: "2026-04-24T23:00:00-07:00",
      endTime: "2026-04-25T00:00:00-07:00",
      temperatureF: 34,
      shortForecast: "Rain and snow",
      detailedForecast: "Rain and snow before midnight, then snow showers after midnight."
    });
    const overnightHour = buildHour({
      startTime: "2026-04-25T02:00:00-07:00",
      endTime: "2026-04-25T03:00:00-07:00",
      temperatureF: 29,
      shortForecast: "Snow showers",
      detailedForecast: "Rain and snow before midnight, then snow showers after midnight."
    });

    expect(getHourlyPrecipLabel(eveningHour, eveningHour.detailedForecast ?? "", testTimeZone)).toBe(
      "snow/mix possible"
    );
    expect(getHourlyPrecipLabel(overnightHour, overnightHour.detailedForecast ?? "", testTimeZone)).toBe(
      "snow"
    );
  });

  it("does not infer snow for warm ambiguous hours above 40F", () => {
    const hour = buildHour({
      temperatureF: 41,
      shortForecast: "Chance of precipitation",
      detailedForecast: "Chance of precipitation overnight."
    });

    expect(getHourlyPrecipLabel(hour, hour.detailedForecast ?? "", testTimeZone)).toBe("precip");
  });

  it("uses precip instead of snow for warm hours without explicit hourly snow text", () => {
    const hour = buildHour({
      temperatureF: 43,
      shortForecast: "Chance of precipitation",
      detailedForecast: "Snow showers later in the night."
    });

    expect(getHourlyPrecipLabel(hour, hour.detailedForecast ?? "", testTimeZone)).toBe("precip");
  });

  it("uses snow possible for warm hours with explicit hourly snow text", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              precipitationChance: 60,
              temperatureF: 42,
              shortForecast: "Snow showers",
              detailedForecast: "Snow showers possible late."
            }),
            score: 52,
            classification: "caution" as const,
            rating: "Caution" as const,
            reasons: ["60% snow possible"],
            breakdown: {
              comfort: 75,
              precipitation: 35,
              wind: 100,
              humidity: 80,
              visibility: 80,
              alerts: 100,
              aqi: 70
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none" as const,
            activeAlertImpact: "none" as const,
            recentAlertImpact: "none" as const,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("60% snow possible");
  });

  it("does not label below-freezing ambiguous precipitation as rain", () => {
    const hour = buildHour({
      temperatureF: 30,
      shortForecast: "Chance of precipitation",
      detailedForecast: "Chance of precipitation after midnight."
    });

    expect(getHourlyPrecipLabel(hour, hour.detailedForecast ?? "", testTimeZone)).toBe("precip");
  });

  it("recommended window after earlier storms does not use thunderstorms as main factor", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T20:00:00-07:00",
          endTime: "2026-04-24T21:00:00-07:00",
          temperatureF: 72,
          shortForecast: "Chance of precipitation",
          detailedForecast: "Thunderstorms before 10pm, then clearing after midnight."
        }),
        buildHour({
          startTime: "2026-04-24T21:00:00-07:00",
          endTime: "2026-04-24T22:00:00-07:00",
          temperatureF: 71,
          shortForecast: "Chance of precipitation",
          detailedForecast: "Thunderstorms before 10pm, then clearing after midnight."
        }),
        buildHour({
          startTime: "2026-04-25T07:00:00-07:00",
          endTime: "2026-04-25T08:00:00-07:00",
          temperatureF: 60,
          shortForecast: "Clear",
          detailedForecast: "Thunderstorms before 10pm, then clearing after midnight."
        }),
        buildHour({
          startTime: "2026-04-25T08:00:00-07:00",
          endTime: "2026-04-25T09:00:00-07:00",
          temperatureF: 62,
          shortForecast: "Sunny",
          detailedForecast: "Thunderstorms before 10pm, then clearing after midnight."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(mergeHoursIntoWindows(hours), hours, "24h", testTimeZone);
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "biking"
    );

    expect(summary.mainFactor).not.toBe("thunderstorms possible");
  });

  it("uses flood chip context instead of a bare flood risk label", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00",
          temperatureF: 58,
          shortForecast: "Cloudy"
        }),
        buildHour({
          startTime: "2026-04-24T19:00:00-07:00",
          endTime: "2026-04-24T20:00:00-07:00",
          temperatureF: 57,
          shortForecast: "Cloudy"
        })
      ],
      alerts: [
        {
          id: "flood-watch",
          event: "Flood Watch",
          severity: "Moderate",
          headline: "Flood watch",
          description: "Flooding possible.",
          onset: "2026-04-24T16:00:00-07:00",
          ends: "2026-04-24T21:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(mergeHoursIntoWindows(hours), hours, "24h", testTimeZone);
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [
          {
            id: "flood-watch",
            event: "Flood Watch",
            severity: "Moderate",
            headline: "Flood watch",
            description: "Flooding possible.",
            onset: "2026-04-24T16:00:00-07:00",
            ends: "2026-04-24T21:00:00-07:00"
          }
        ],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "social"
    );

    expect(summary.contextNote).toBe("Flood Watch until 9:00 PM");
    expect(summary.contextNote).not.toBe("Flood risk");
  });

  it("scores a 2-hour planned event with all good hours as good", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          temperatureF: 66,
          apparentTemperatureF: 66
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          temperatureF: 68,
          apparentTemperatureF: 68
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "10:00",
      timeZone: testTimeZone,
      activity: "biking",
      suggestAlternates: true
    });

    expect(eventResult.rating).toBe("Good");
  });

  it("marks a planned event with one active warning hour as avoid", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T16:00:00-07:00",
          endTime: "2026-04-24T17:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "event-warning",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T16:30:00-07:00",
          ends: "2026-04-24T17:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "16:00",
      eventEndTime: "18:00",
      timeZone: testTimeZone,
      activity: "exercise",
      suggestAlternates: true
    });

    expect(eventResult.rating).toBe("Avoid");
  });

  it("uses the alert-blocked message for planned events with warning overlap", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T16:00:00-07:00",
          endTime: "2026-04-24T17:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "event-warning",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T16:30:00-07:00",
          ends: "2026-04-24T17:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "16:00",
      eventEndTime: "18:00",
      timeZone: testTimeZone,
      activity: "exercise",
      suggestAlternates: false
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours,
      alerts: [
        {
          id: "event-warning",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Severe thunderstorm warning",
          description: "Storms nearby.",
          onset: "2026-04-24T16:30:00-07:00",
          ends: "2026-04-24T17:30:00-07:00"
        }
      ]
    });

    expect(summary.messageType).toBe("alert_blocked");
    expect(summary.heading).toBe("Consider rescheduling");
    expect(summary.mainFactor).toBe("active weather warnings");
  });

  it("does not return good for a 5-hour event with one avoid hour", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Heavy rain",
          detailedForecast: "Heavy rain and flooding possible."
        }),
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T12:00:00-07:00",
          endTime: "2026-04-24T13:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "13:00",
      timeZone: testTimeZone,
      activity: "biking",
      suggestAlternates: true
    });

    expect(eventResult.rating).not.toBe("Good");
  });

  it("returns a same-duration better alternate for a caution event", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through mid-morning."
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely through mid-morning."
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "10:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: true
    });

    expect(eventResult.rating).toBe("Caution");
    expect(eventResult.bestAlternateWindow).not.toBeNull();
    expect(eventResult.bestAlternateWindow?.classification).toBe("good");
  });

  it("returns a 5-hour alternate for a 5-hour event", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({ startTime: "2026-04-24T08:00:00-07:00", endTime: "2026-04-24T09:00:00-07:00", shortForecast: "Thunderstorms likely", detailedForecast: "Thunderstorms likely through the late morning." }),
        buildHour({ startTime: "2026-04-24T09:00:00-07:00", endTime: "2026-04-24T10:00:00-07:00", shortForecast: "Thunderstorms likely", detailedForecast: "Thunderstorms likely through the late morning." }),
        buildHour({ startTime: "2026-04-24T10:00:00-07:00", endTime: "2026-04-24T11:00:00-07:00", shortForecast: "Thunderstorms likely", detailedForecast: "Thunderstorms likely through the late morning." }),
        buildHour({ startTime: "2026-04-24T11:00:00-07:00", endTime: "2026-04-24T12:00:00-07:00", shortForecast: "Thunderstorms likely", detailedForecast: "Thunderstorms likely through the late morning." }),
        buildHour({ startTime: "2026-04-24T12:00:00-07:00", endTime: "2026-04-24T13:00:00-07:00", shortForecast: "Thunderstorms likely", detailedForecast: "Thunderstorms likely through the late morning." }),
        buildHour({ startTime: "2026-04-24T13:00:00-07:00", endTime: "2026-04-24T14:00:00-07:00" }),
        buildHour({ startTime: "2026-04-24T14:00:00-07:00", endTime: "2026-04-24T15:00:00-07:00" }),
        buildHour({ startTime: "2026-04-24T15:00:00-07:00", endTime: "2026-04-24T16:00:00-07:00" }),
        buildHour({ startTime: "2026-04-24T16:00:00-07:00", endTime: "2026-04-24T17:00:00-07:00" }),
        buildHour({ startTime: "2026-04-24T17:00:00-07:00", endTime: "2026-04-24T18:00:00-07:00" })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "13:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: true
    });

    expect(eventResult.bestAlternateWindow).not.toBeNull();
    const alternateDurationHours =
      (new Date(eventResult.bestAlternateWindow!.endTime).getTime() -
        new Date(eventResult.bestAlternateWindow!.startTime).getTime()) /
      (60 * 60 * 1000);
    expect(alternateDurationHours).toBe(5);
  });

  it("returns a friendly error when an event is beyond available forecast range", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });

    expect(() =>
      scorePlannedEvent({
        scoredHours,
        eventDate: "2026-04-26",
        eventStartTime: "08:00",
        eventEndTime: "10:00",
        timeZone: testTimeZone,
        activity: "social",
        suggestAlternates: true
      })
    ).toThrow("This event is outside the available hourly forecast range.");
  });

  it("shows a lower-confidence note for events more than 48 hours out", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-26T08:00:00-07:00",
          endTime: "2026-04-26T09:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-26T09:00:00-07:00",
          endTime: "2026-04-26T10:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-26",
      eventStartTime: "08:00",
      eventEndTime: "10:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: false,
      now: new Date("2026-04-24T00:00:00-07:00")
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours
    });

    expect(summary.confidenceExplanation).toBe(
      "Forecast confidence decreases this far out. Recheck closer to the event."
    );
  });

  it("adds an event insight for a good event when hazards return later", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T15:00:00-07:00",
          endTime: "2026-04-24T16:00:00-07:00",
          shortForecast: "Thunderstorms likely"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "10:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: false
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours
    });

    expect(eventResult.rating).toBe("Good");
    expect(summary.highlightInsight).toBe(
      "Most of your event is fine, but thunderstorms may return later in the day."
    );
    expect(summary.note).toBeUndefined();
  });

  it("renders the highlight insight in the recommendation card once", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "94110",
            label: "San Francisco, CA",
            latitude: 37.75,
            longitude: -122.41,
            timeZone: testTimeZone
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Thu, Apr 24 8:00 AM - 10:00 AM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation:
              "Other green hours may still be available, but this stretch has the best balance of comfort, precipitation risk, and safety using the best available weather conditions.",
            highlightInsight: "Best window ends before thunderstorms return around 10:00 AM.",
            mainFactor: "low precipitation risk"
          },
          bestWindow: {
            startTime: "2026-04-24T08:00:00-07:00",
            endTime: "2026-04-24T10:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 88,
            reasons: ["low precip risk"],
            hours: [],
            daylightTier: "daylight",
            selectedAsDaylightFallback: false
          },
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: {
            available: true
          },
          airQuality: {
            primary: null,
            available: false
          },
          generatedAt: "2026-04-24T08:00:00Z"
        }
      })
    );

    expect(markup.match(/Best window ends before thunderstorms return around 10:00 AM\./g)?.length).toBe(1);
  });

  it("does not show a worst period card for a good event", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "94110",
            label: "San Francisco, CA",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          planningMode: "event",
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Fri, Apr 24 8:00 AM - 10:00 AM",
            heading: "Your event looks good",
            confidence: "High",
            confidenceExplanation: "This event window looks favorable within the available hourly forecast.",
            explanation: "This planned window has favorable conditions based on the available forecast.",
            riskTrend: "Conditions stable",
            mainFactor: "comfortable around 68F"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: {
            startTime: "2026-04-24T15:00:00.000Z",
            endTime: "2026-04-24T17:00:00.000Z",
            durationMs: 2 * 60 * 60 * 1000,
            score: 88,
            rating: "Good",
            classification: "good",
            reasons: ["comfortable around 68F"],
            overlappingHours: [],
            worstWindow: {
              startTime: "2026-04-24T15:00:00.000Z",
              endTime: "2026-04-24T16:00:00.000Z",
              classification: "good",
              rating: "Good",
              averageScore: 88,
              reasons: ["comfortable around 68F"],
              hours: []
            },
            bestAlternateWindow: null,
            bestAlternateReason: undefined,
            mainConcern: "comfortable around 68F"
          },
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).not.toContain("Worst period:");
  });

  it("includes a reason for why the alternate event window is better", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          windGustMph: 28
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          windGustMph: 28
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Sunny"
        }),
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00",
          shortForecast: "Sunny"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "08:00",
      eventEndTime: "10:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: true
    });

    expect(eventResult.bestAlternateWindow).not.toBeNull();
    expect(eventResult.bestAlternateReason).toBeTruthy();
  });

  it("keeps the event timeline focused and shows a later available option divider", () => {
    const hours = Array.from({ length: 22 }, (_, index) => ({
      forecast: buildHour({
        startTime: `2026-04-24T${String(index).padStart(2, "0")}:00:00-07:00`,
        endTime: `2026-04-24T${String(index + 1).padStart(2, "0")}:00:00-07:00`,
        temperatureF: 50 + index,
        shortForecast: "Clear"
      }),
      score: 86,
      classification: "good" as const,
      rating: "Good" as const,
      reasons: ["comfortable around 68F"],
      breakdown: {
        comfort: 90,
        precipitation: 100,
        wind: 90,
        humidity: 80,
        visibility: 90,
        alerts: 100,
        aqi: 70
      },
      airQuality: null,
      hasRelevantAlert: false,
      alertImpact: "none" as const,
      activeAlertImpact: "none" as const,
      recentAlertImpact: "none" as const,
      alertContext: null
    }));

    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours,
        timeZone: testTimeZone,
        plannedWindow: {
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          label: "Planned event"
        },
        alternateWindow: {
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T20:00:00-07:00",
          label: "Suggested alternate"
        }
      })
    );

    expect(markup).toContain("Later available option");
    expect(markup).toContain("Planned event");
    expect(markup).toContain("Suggested alternate");
    expect(markup).not.toContain("63F");
  });

  it("shows flood watch timing context as a separate event context note", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "flood-watch",
          event: "Flood Watch",
          severity: "Moderate",
          headline: "Flood watch",
          description: "Flooding is possible this evening.",
          onset: "2026-04-24T16:00:00-07:00",
          ends: "2026-04-24T21:00:00-07:00"
        }
      ],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "17:00",
      eventEndTime: "19:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: false
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours,
      alerts: [
        {
          id: "flood-watch",
          event: "Flood Watch",
          severity: "Moderate",
          headline: "Flood watch",
          description: "Flooding is possible this evening.",
          onset: "2026-04-24T16:00:00-07:00",
          ends: "2026-04-24T21:00:00-07:00"
        }
      ]
    });

    expect(summary.contextNote).toBe("Flood Watch until 9:00 PM");
  });

  it("uses a combined main concern for mixed winter event hazards", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T17:00:00-07:00",
          endTime: "2026-04-24T18:00:00-07:00",
          temperatureF: 29,
          apparentTemperatureF: 24,
          visibilityMiles: 0.5,
          shortForecast: "Snow showers",
          detailedForecast: "Snow showers with patchy fog."
        }),
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00",
          temperatureF: 30,
          apparentTemperatureF: 25,
          visibilityMiles: 0.75,
          shortForecast: "Snow showers",
          detailedForecast: "Snow showers and fog."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "17:00",
      eventEndTime: "19:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: false
    });

    expect(eventResult.mainConcern).toBe("snow, cold, and reduced visibility");
  });

  it("limits event why-panel reasons to three items", () => {
    const markup = renderToStaticMarkup(
      createElement(WhyPanel, {
        result: {
          location: {
            postalCode: "94110",
            label: "San Francisco, CA",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          planningMode: "event",
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Fri, Apr 24 5:00 PM - 8:00 PM",
            heading: "Use caution for this event",
            confidence: "Medium",
            confidenceExplanation: "Some weather factors could still affect this event window.",
            explanation: "This event may still work, but weather could affect comfort or safety.",
            riskTrend: "Thunderstorm risk decreases after this period",
            mainFactor: "active storm risk during the event"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: {
            startTime: "2026-04-24T17:00:00-07:00",
            endTime: "2026-04-24T20:00:00-07:00",
            durationMs: 3 * 60 * 60 * 1000,
            score: 52,
            rating: "Caution",
            classification: "caution",
            reasons: [
              "Severe thunderstorm watch in effect",
              "thunderstorms possible",
              "reduced visibility around 2 miles",
              "80% precip chance"
            ],
            overlappingHours: [],
            worstWindow: null,
            bestAlternateWindow: null,
            bestAlternateReason: undefined,
            mainConcern: "active storm risk during the event"
          },
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect((markup.match(/<li/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("removes comfort reasons when event hazards exist", () => {
    const markup = renderToStaticMarkup(
      createElement(WhyPanel, {
        result: {
          location: {
            postalCode: "94110",
            label: "San Francisco, CA",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          planningMode: "event",
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Fri, Apr 24 5:00 PM - 8:00 PM",
            heading: "Use caution for this event",
            confidence: "Medium",
            confidenceExplanation: "Some weather factors could still affect this event window.",
            explanation: "This event may still work, but weather could affect comfort or safety.",
            riskTrend: "Thunderstorm risk decreases after this period",
            mainFactor: "thunderstorms possible during the event"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: {
            startTime: "2026-04-24T17:00:00-07:00",
            endTime: "2026-04-24T20:00:00-07:00",
            durationMs: 3 * 60 * 60 * 1000,
            score: 52,
            rating: "Caution",
            classification: "caution",
            reasons: ["comfortable around 68F", "thunderstorms possible", "60% precip chance"],
            overlappingHours: [],
            worstWindow: null,
            bestAlternateWindow: null,
            bestAlternateReason: undefined,
            mainConcern: "thunderstorms possible during the event"
          },
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).not.toContain("comfortable around 68F");
  });

  it("shows a longer-range alternate label when the alternate is far later", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "94110",
            label: "San Francisco, CA",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          planningMode: "event",
          activity: "social",
          horizon: "48h",
          summary: {
            recommendation: "Fri, Apr 24 5:00 PM - 7:00 PM",
            heading: "Use caution for this event",
            confidence: "Medium",
            confidenceExplanation: "Some weather factors could still affect this event window.",
            explanation: "This event may still work, but weather could affect comfort or safety.",
            riskTrend: "Thunderstorm risk decreases after this period",
            mainFactor: "thunderstorms possible during the event"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: {
            startTime: "2026-04-24T17:00:00-07:00",
            endTime: "2026-04-24T19:00:00-07:00",
            durationMs: 2 * 60 * 60 * 1000,
            score: 48,
            rating: "Caution",
            classification: "caution",
            reasons: ["thunderstorms possible"],
            overlappingHours: [],
            worstWindow: null,
            bestAlternateWindow: {
              startTime: "2026-04-26T20:00:00-07:00",
              endTime: "2026-04-26T22:00:00-07:00",
              classification: "good",
              rating: "Good",
              averageScore: 86,
              reasons: ["low precip risk"],
              hours: []
            },
            bestAlternateReason: "no thunderstorms or hazardous precipitation, lower wind",
            mainConcern: "thunderstorms possible during the event",
            guidanceNote: "Forecast confidence is lower this far out."
          },
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain("Later available option (longer-range forecast):");
    expect(markup).toContain("Forecast confidence is lower this far out.");
  });

  it("matches event times in the forecast location timezone", () => {
    const easternTimeZone = "America/New_York";
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-25T11:00:00.000Z",
          endTime: "2026-04-25T12:00:00.000Z"
        }),
        buildHour({
          startTime: "2026-04-25T12:00:00.000Z",
          endTime: "2026-04-25T13:00:00.000Z"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: easternTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-25",
      eventStartTime: "07:00",
      eventEndTime: "09:00",
      timeZone: easternTimeZone,
      activity: "social",
      suggestAlternates: false
    });

    expect(eventResult.overlappingHours).toHaveLength(2);
  });

  it("does not recommend overnight hiking when daylight options exist", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T02:00:00-07:00",
          endTime: "2026-04-24T03:00:00-07:00",
          temperatureF: 60
        }),
        buildHour({
          startTime: "2026-04-24T03:00:00-07:00",
          endTime: "2026-04-24T04:00:00-07:00",
          temperatureF: 60
        }),
        buildHour({
          startTime: "2026-04-24T04:00:00-07:00",
          endTime: "2026-04-24T05:00:00-07:00",
          temperatureF: 60
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          temperatureF: 58
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          temperatureF: 59
        }),
        buildHour({
          startTime: "2026-04-24T11:00:00-07:00",
          endTime: "2026-04-24T12:00:00-07:00",
          temperatureF: 60
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "hiking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "hiking"
    );

    expect(selected.bestWindow?.startTime).toBe("2026-04-24T09:00:00-07:00");
  });

  it("kids sports chooses a daylight window over an evening window when both are good", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T09:00:00-07:00",
          endTime: "2026-06-20T10:00:00-07:00",
          temperatureF: 67,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T10:00:00-07:00",
          endTime: "2026-06-20T11:00:00-07:00",
          temperatureF: 68,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T20:00:00-07:00",
          endTime: "2026-06-20T21:00:00-07:00",
          temperatureF: 66,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T21:00:00-07:00",
          endTime: "2026-06-20T22:00:00-07:00",
          temperatureF: 64,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.startTime).toBe("2026-06-20T09:00:00-07:00");
  });

  it("kids sports may use a mixed-light window only if no daylight option exists", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T19:30:00-07:00",
          endTime: "2026-06-20T20:30:00-07:00",
          temperatureF: 67,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T20:30:00-07:00",
          endTime: "2026-06-20T21:30:00-07:00",
          temperatureF: 65,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow).not.toBeNull();
    expect(selected.bestWindow?.rating).toBe("Caution");
    expect(selected.bestWindow?.selectedAsDaylightFallback).toBe(true);
    expect(summary.heading).toBe("Best available window");
    expect(summary.decisionChip).toBe("Fallback window");
  });

  it("kids sports Tonight does not return a normal good nighttime window when no daylight remains", () => {
    const tonightHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T20:00:00-07:00",
          endTime: "2026-06-20T21:00:00-07:00",
          temperatureF: 67,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T21:00:00-07:00",
          endTime: "2026-06-20T22:00:00-07:00",
          temperatureF: 65,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const nextDayHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-21T09:00:00-07:00",
          endTime: "2026-06-21T10:00:00-07:00",
          temperatureF: 66,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-21T10:00:00-07:00",
          endTime: "2026-06-21T11:00:00-07:00",
          temperatureF: 67,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(tonightHours),
      tonightHours,
      "tonight",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const nextAvailableWindow = selectBestWindows(
      mergeHoursIntoWindows(nextDayHours),
      nextDayHours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    ).bestWindow;
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: tonightHours,
        nextAvailableWindow
      },
      "tonight",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow).toBeNull();
    expect(summary.heading).toBe("No good daylight window tonight");
    expect(summary.messageType).toBe("daylight_limited");
    expect(summary.explanation).toBe("Try Next 24 hours.");
    expect(summary.mainFactor).toBe("no usable daylight window");
  });

  it("biking Tonight does not return a normal good nighttime window", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T20:00:00-07:00",
          endTime: "2026-06-20T21:00:00-07:00",
          temperatureF: 63,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T21:00:00-07:00",
          endTime: "2026-06-20T22:00:00-07:00",
          temperatureF: 61,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "tonight",
      testTimeZone,
      "biking",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow).toBeNull();
  });

  it("daylight-required activities avoid overnight windows when daylight good or caution windows exist", () => {
    const activities = ["biking", "yardWork", "outdoorWork"] as const;

    for (const activity of activities) {
      const hours = scoreForecastHours({
        hours: [
          buildHour({
            startTime: "2026-04-24T02:00:00-07:00",
            endTime: "2026-04-24T03:00:00-07:00",
            temperatureF: 61,
            isDaytime: false
          }),
          buildHour({
            startTime: "2026-04-24T03:00:00-07:00",
            endTime: "2026-04-24T04:00:00-07:00",
            temperatureF: 61,
            isDaytime: false
          }),
          buildHour({
            startTime: "2026-04-24T09:00:00-07:00",
            endTime: "2026-04-24T10:00:00-07:00",
            temperatureF: 58,
            isDaytime: true
          }),
          buildHour({
            startTime: "2026-04-24T10:00:00-07:00",
            endTime: "2026-04-24T11:00:00-07:00",
            temperatureF: 59,
            isDaytime: true
          }),
          buildHour({
            startTime: "2026-04-24T11:00:00-07:00",
            endTime: "2026-04-24T12:00:00-07:00",
            temperatureF: 60,
            isDaytime: true
          })
        ],
        alerts: [],
        airQuality: null,
        activity,
        timeZone: testTimeZone
      });
      const selected = selectBestWindows(
        mergeHoursIntoWindows(hours),
        hours,
        "24h",
        testTimeZone,
        activity,
        {
          latitude: 34.0522,
          longitude: -118.2437
        }
      );

      expect(selected.bestWindow?.startTime).toBe("2026-04-24T09:00:00-07:00");
    }
  });

  it("planned nighttime hiking can score normally but adds a daylight note", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T21:00:00-07:00",
          endTime: "2026-04-24T22:00:00-07:00",
          temperatureF: 58
        }),
        buildHour({
          startTime: "2026-04-24T22:00:00-07:00",
          endTime: "2026-04-24T23:00:00-07:00",
          temperatureF: 57
        }),
        buildHour({
          startTime: "2026-04-24T23:00:00-07:00",
          endTime: "2026-04-25T00:00:00-07:00",
          temperatureF: 56
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "hiking",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "21:00",
      eventEndTime: "23:00",
      timeZone: testTimeZone,
      activity: "hiking",
      suggestAlternates: false
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours
    });

    expect(eventResult.rating).toBe("Good");
    expect(summary.note).toContain("This activity usually requires daylight.");
  });

  it("planned nighttime kids sports scores normally but adds a daylight note", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T20:00:00-07:00",
          endTime: "2026-04-24T21:00:00-07:00",
          temperatureF: 66,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-04-24T21:00:00-07:00",
          endTime: "2026-04-24T22:00:00-07:00",
          temperatureF: 64,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "20:00",
      eventEndTime: "22:00",
      timeZone: testTimeZone,
      activity: "kidsSports",
      suggestAlternates: false,
      latitude: 34.0522,
      longitude: -118.2437
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours
    });

    expect(eventResult.rating).toBe("Good");
    expect(summary.note).toContain("This activity usually requires daylight.");
  });

  it("kids sports mixed-light window cannot return Good", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T05:00:00-07:00",
          endTime: "2026-06-20T06:00:00-07:00",
          temperatureF: 58,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-20T06:00:00-07:00",
          endTime: "2026-06-20T07:00:00-07:00",
          temperatureF: 60,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.daylightTier).toBe("mixed-light");
    expect(selected.bestWindow?.rating).toBe("Caution");
    expect(summary.heading).toBe("Best available window");
  });

  it("kids sports daylight storm hours now use the fallback message instead of a normal recommendation", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T09:00:00-07:00",
          endTime: "2026-06-20T10:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely in the morning.",
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T10:00:00-07:00",
          endTime: "2026-06-20T11:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely in the morning.",
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T20:00:00-07:00",
          endTime: "2026-06-20T21:00:00-07:00",
          temperatureF: 66,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T21:00:00-07:00",
          endTime: "2026-06-20T22:00:00-07:00",
          temperatureF: 64,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.selectedAsDaylightFallback).toBe(true);
    expect(summary.messageType).toBe("fallback");
    expect(summary.explanation).toBe(
      "Conditions are not ideal, but this is the most workable time."
    );
  });

  it("biking follows the same daylight-required fallback rule", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T05:00:00-07:00",
          endTime: "2026-06-20T06:00:00-07:00",
          temperatureF: 57,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-20T06:00:00-07:00",
          endTime: "2026-06-20T07:00:00-07:00",
          temperatureF: 59,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "biking",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.rating).toBe("Caution");
    expect(selected.bestWindow?.selectedAsDaylightFallback).toBe(true);
  });

  it("fishing Tonight can still return a night window", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T01:00:00-07:00",
          endTime: "2026-06-20T02:00:00-07:00",
          temperatureF: 58,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-20T02:00:00-07:00",
          endTime: "2026-06-20T03:00:00-07:00",
          temperatureF: 58,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "fishing",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "tonight",
      testTimeZone,
      "fishing",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "tonight",
      testTimeZone,
      "fishing",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow).not.toBeNull();
    expect(summary.decisionChip).toBe("Late-night option");
    expect(summary.mainFactor).not.toContain("storm");
  });

  it("daylight fallback uses the unified fallback main factor instead of comfort language", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T19:30:00-07:00",
          endTime: "2026-06-20T20:30:00-07:00",
          temperatureF: 67,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T20:30:00-07:00",
          endTime: "2026-06-20T21:30:00-07:00",
          temperatureF: 65,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(summary.mainFactor).not.toContain("comfortable");
    expect(summary.mainFactor).toBe("limited but usable conditions");
  });

  it("caution hours include a limiting reason in timeline output", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-29T17:00:00-04:00",
          endTime: "2026-04-29T18:00:00-04:00",
          temperatureF: 58,
          apparentTemperatureF: 58,
          windSpeedMph: 12,
          windGustMph: 14,
          precipitationChance: 31,
          visibilityMiles: 5,
          shortForecast: "Chance Rain Showers",
          detailedForecast: ""
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking",
      timeZone: "America/New_York"
    });

    expect(hour.classification).toBe("caution");
    expect(
      hour.reasons.some((reason) =>
        ["31% rain chance", "wind picks up near 12 mph", "reduced visibility around 5 miles"].includes(
          reason
        )
      )
    ).toBe(true);
  });

  it("Next 24h for kids sports still picks a daylight good window", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T20:00:00-07:00",
          endTime: "2026-06-20T21:00:00-07:00",
          temperatureF: 67,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T21:00:00-07:00",
          endTime: "2026-06-20T22:00:00-07:00",
          temperatureF: 65,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-21T09:00:00-07:00",
          endTime: "2026-06-21T10:00:00-07:00",
          temperatureF: 66,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-21T10:00:00-07:00",
          endTime: "2026-06-21T11:00:00-07:00",
          temperatureF: 67,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "kidsSports",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "kidsSports",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.startTime).toBe("2026-06-21T09:00:00-07:00");
  });

  it("running avoids 12 AM to 5 AM recommendations when a reasonable daylight option exists", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T01:00:00-07:00",
          endTime: "2026-04-24T02:00:00-07:00",
          temperatureF: 63,
          apparentTemperatureF: 63
        }),
        buildHour({
          startTime: "2026-04-24T02:00:00-07:00",
          endTime: "2026-04-24T03:00:00-07:00",
          temperatureF: 63,
          apparentTemperatureF: 63
        }),
        buildHour({
          startTime: "2026-04-24T07:00:00-07:00",
          endTime: "2026-04-24T08:00:00-07:00",
          temperatureF: 61,
          apparentTemperatureF: 61
        }),
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          temperatureF: 62,
          apparentTemperatureF: 62
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "running",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "running"
    );

    expect(selected.bestWindow?.startTime).toBe("2026-04-24T07:00:00-07:00");
  });

  it("running prefers daylight or mixed-light over late night", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-20T01:00:00-07:00",
          endTime: "2026-06-20T02:00:00-07:00",
          temperatureF: 62,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-20T02:00:00-07:00",
          endTime: "2026-06-20T03:00:00-07:00",
          temperatureF: 62,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-20T19:30:00-07:00",
          endTime: "2026-06-20T20:30:00-07:00",
          temperatureF: 61,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-20T20:30:00-07:00",
          endTime: "2026-06-20T21:30:00-07:00",
          temperatureF: 60,
          isDaytime: false
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "running",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "running",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "running",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.startTime).toBe("2026-06-20T19:30:00-07:00");
    expect(summary.note).toBeUndefined();
  });

  it("fishing may use a late-night window and labels it clearly", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T01:00:00-07:00",
          endTime: "2026-04-24T02:00:00-07:00",
          temperatureF: 58,
          apparentTemperatureF: 58
        }),
        buildHour({
          startTime: "2026-04-24T02:00:00-07:00",
          endTime: "2026-04-24T03:00:00-07:00",
          temperatureF: 58,
          apparentTemperatureF: 58
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "fishing",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "fishing"
    );
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "fishing"
    );

    expect(selected.bestWindow?.startTime).toBe("2026-04-24T01:00:00-07:00");
    expect(summary.decisionChip).toBe("Late-night option");
  });

  it("normalizes Open-Meteo hourly AQI readings", () => {
    const readings = normalizeOpenMeteoAirQuality({
      hourly: {
        time: ["2026-04-29T08:00", "2026-04-29T09:00"],
        us_aqi: [42, 118]
      },
      timezone: "America/Chicago"
    });

    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      parameter: "US AQI",
      aqi: 42,
      category: "Good",
      source: "Open-Meteo Air Quality"
    });
    expect(readings[1].category).toBe("Unhealthy for Sensitive Groups");
  });

  it("uses the correct AQI category thresholds", () => {
    expect(getOpenMeteoAqiCategory(50)).toBe("Good");
    expect(getOpenMeteoAqiCategory(75)).toBe("Moderate");
    expect(getOpenMeteoAqiCategory(120)).toBe("Unhealthy for Sensitive Groups");
    expect(getOpenMeteoAqiCategory(180)).toBe("Unhealthy");
    expect(getOpenMeteoAqiCategory(240)).toBe("Very Unhealthy");
    expect(getOpenMeteoAqiCategory(320)).toBe("Hazardous");
  });

  it("matches AQI readings to forecast hours by local hour", () => {
    const hours = [
      buildHour({
        startTime: "2026-04-29T08:00:00-05:00",
        endTime: "2026-04-29T09:00:00-05:00"
      }),
      buildHour({
        startTime: "2026-04-29T09:00:00-05:00",
        endTime: "2026-04-29T10:00:00-05:00"
      })
    ];
    const readings = normalizeOpenMeteoAirQuality({
      hourly: {
        time: ["2026-04-29T08:00", "2026-04-29T09:00"],
        us_aqi: [44, 122]
      }
    });

    const matched = matchAirQualityToForecastHours(hours, readings, "America/Chicago");

    expect(matched.get("2026-04-29 08")?.aqi).toBe(44);
    expect(matched.get("2026-04-29 09")?.aqi).toBe(122);
  });

  it("treats missing AQI matches as neutral without crashing", () => {
    const [hour] = scoreForecastHours({
      hours: [buildHour({ startTime: "2026-04-29T08:00:00-05:00", endTime: "2026-04-29T09:00:00-05:00" })],
      alerts: [],
      airQuality: null,
      airQualityByHour: new Map<string, AirQualityReading | null>([
        ["2026-04-29 10", {
          parameter: "US AQI",
          aqi: 150,
          category: "Unhealthy for Sensitive Groups",
          reportingArea: "Open-Meteo",
          stateCode: "",
          dateObserved: "2026-04-29",
          hourObserved: 10,
          source: "Open-Meteo Air Quality"
        }]
      ]),
      activity: "walking",
      timeZone: "America/Chicago"
    });

    expect(hour.score).toBeGreaterThan(0);
    expect(hour.airQuality).toBeNull();
  });

  it("running is more sensitive to heat and AQI than outdoor dining", () => {
    const [runningHour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 96,
          apparentTemperatureF: 101
        })
      ],
      alerts: [],
      airQuality: {
        parameter: "PM2.5",
        aqi: 125,
        category: "Unhealthy for Sensitive Groups",
        reportingArea: "San Francisco",
        stateCode: "CA",
        dateObserved: "2026-04-24"
      },
      activity: "running"
    });
    const [diningHour] = scoreForecastHours({
      hours: [
        buildHour({
          temperatureF: 96,
          apparentTemperatureF: 101
        })
      ],
      alerts: [],
      airQuality: {
        parameter: "PM2.5",
        aqi: 125,
        category: "Unhealthy for Sensitive Groups",
        reportingArea: "San Francisco",
        stateCode: "CA",
        dateObserved: "2026-04-24"
      },
      activity: "dining"
    });

    expect(runningHour.score).toBeLessThan(diningHour.score);
  });

  it("AQI 120 penalizes exercise more than outdoor dining", () => {
    const reading = {
      parameter: "US AQI",
      aqi: 120,
      category: "Unhealthy for Sensitive Groups",
      reportingArea: "Open-Meteo",
      stateCode: "",
      dateObserved: "2026-04-24",
      hourObserved: 9,
      source: "Open-Meteo Air Quality"
    } satisfies AirQualityReading;

    const [exerciseHour] = scoreForecastHours({
      hours: [buildHour({})],
      alerts: [],
      airQuality: reading,
      activity: "exercise"
    });
    const [diningHour] = scoreForecastHours({
      hours: [buildHour({})],
      alerts: [],
      airQuality: reading,
      activity: "dining"
    });

    expect(exerciseHour.score).toBeLessThan(diningHour.score);
    expect(exerciseHour.reasons).toContain("air quality may affect sensitive groups");
  });

  it("AQI 180 prevents a good rating for AQI-sensitive activities", () => {
    const [kidsSportsHour] = scoreForecastHours({
      hours: [buildHour({})],
      alerts: [],
      airQuality: {
        parameter: "US AQI",
        aqi: 180,
        category: "Unhealthy",
        reportingArea: "Open-Meteo",
        stateCode: "",
        dateObserved: "2026-04-24",
        hourObserved: 9,
        source: "Open-Meteo Air Quality"
      },
      activity: "kidsSports"
    });

    expect(kidsSportsHour.rating).not.toBe("Good");
    expect(kidsSportsHour.reasons).toContain("unhealthy air quality");
  });

  it("renders Open-Meteo as the default AQI source in the panel", () => {
    const markup = renderToStaticMarkup(
      createElement(AirQualityPanel, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 0,
            longitude: 0,
            timeZone: testTimeZone
          },
          planningMode: "flexible",
          activity: "social",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions."
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: {
            primary: {
              parameter: "US AQI",
              aqi: 62,
              category: "Moderate",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            available: true
          },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain(">62<");
    expect(markup).toContain("Moderate");
    expect(markup).toContain("US AQI");
    expect(markup).not.toContain("AirNow API key");
  });

  it("labels the alerts panel as current conditions", () => {
    const markup = renderToStaticMarkup(
      createElement(AlertsPanel, {
        alerts: [],
        available: true
      })
    );

    expect(markup).toContain("Active alerts (current conditions)");
    expect(markup).toContain(
      "Shows currently active warnings from the National Weather Service."
    );
  });

  it("keeps the full AQI category name in the air quality panel", () => {
    const markup = renderToStaticMarkup(
      createElement(AirQualityPanel, {
        result: {
          location: {
            postalCode: "85001",
            label: "Phoenix, AZ",
            latitude: 33.4484,
            longitude: -112.074,
            timeZone: "America/Phoenix"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            mainFactor: "comfortable conditions"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: {
            primary: {
              parameter: "US AQI",
              aqi: 112,
              category: "Unhealthy for Sensitive Groups",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            available: true
          },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain(">112<");
    expect(markup).toContain("Unhealthy for Sensitive Groups");
    expect(markup).toContain("US AQI");
    expect(markup).toContain("Current air quality");
    expect(markup).toContain("Forecast values are shown in the hourly timeline.");
  });

  it("biking is more sensitive to gusts and visibility than outdoor hangout", () => {
    const [bikingHour] = scoreForecastHours({
      hours: [
        buildHour({
          windGustMph: 34,
          visibilityMiles: 2
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "biking"
    });
    const [socialHour] = scoreForecastHours({
      hours: [
        buildHour({
          windGustMph: 34,
          visibilityMiles: 2
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social"
    });

    expect(bikingHour.score).toBeLessThan(socialHour.score);
  });

  it("outdoor dining is more sensitive to precipitation than walking", () => {
    const [diningHour] = scoreForecastHours({
      hours: [
        buildHour({
          precipitationChance: 65,
          shortForecast: "Showers"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "dining"
    });
    const [walkingHour] = scoreForecastHours({
      hours: [
        buildHour({
          precipitationChance: 65,
          shortForecast: "Showers"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "walking"
    });

    expect(diningHour.score).toBeLessThan(walkingHour.score);
  });

  it("photography reacts to fog, smoke, and reduced visibility", () => {
    const [hazyHour] = scoreForecastHours({
      hours: [
        buildHour({
          visibilityMiles: 1.5,
          shortForecast: "Haze",
          detailedForecast: "Areas of smoke and patchy fog."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "photography",
      timeZone: testTimeZone
    });
    const [clearHour] = scoreForecastHours({
      hours: [buildHour({ shortForecast: "Clear", visibilityMiles: 10 })],
      alerts: [],
      airQuality: null,
      activity: "photography",
      timeZone: testTimeZone
    });

    expect(hazyHour.score).toBeLessThan(clearHour.score);
    expect(hazyHour.reasons).toEqual(
      expect.arrayContaining(["fog may reduce visibility", "smoke may affect air quality"])
    );
  });

  it("walking accepts a shorter one-hour window", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Clear"
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "walking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "walking"
    );

    expect(selected.bestWindow).not.toBeNull();
    expect(selected.bestWindow?.hours).toHaveLength(1);
  });

  it("keeps the original activity modes available", () => {
    expect(getActivityConfig("exercise").label).toBe("General exercise");
    expect(getActivityConfig("social").label).toBe("Outdoor hangout");
    expect(getActivityConfig("study").label).toBe("Study outside");
  });

  it("uses later summer daylight in a northern location than winter daylight in a southern location", () => {
    const seattleSummer = getSunTimesForDate(
      "2026-06-21T12:00:00-07:00",
      47.6062,
      -122.3321,
      "America/Los_Angeles"
    );
    const miamiWinter = getSunTimesForDate(
      "2026-01-15T12:00:00-05:00",
      25.7617,
      -80.1918,
      "America/New_York"
    );

    expect(seattleSummer).not.toBeNull();
    expect(miamiWinter).not.toBeNull();
    expect(new Date(seattleSummer!.sunset).getTime()).toBeGreaterThan(
      new Date(miamiWinter!.sunset).getTime()
    );
  });

  it("uses real daylight overlap when choosing hiking windows", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-06-21T02:00:00-07:00",
          endTime: "2026-06-21T03:00:00-07:00",
          temperatureF: 59,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-21T03:00:00-07:00",
          endTime: "2026-06-21T04:00:00-07:00",
          temperatureF: 59,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-21T04:00:00-07:00",
          endTime: "2026-06-21T05:00:00-07:00",
          temperatureF: 58,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-06-21T08:00:00-07:00",
          endTime: "2026-06-21T09:00:00-07:00",
          temperatureF: 57,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-21T09:00:00-07:00",
          endTime: "2026-06-21T10:00:00-07:00",
          temperatureF: 58,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-06-21T10:00:00-07:00",
          endTime: "2026-06-21T11:00:00-07:00",
          temperatureF: 59,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "hiking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "hiking",
      {
        latitude: 47.6062,
        longitude: -122.3321
      }
    );

    expect(selected.bestWindow?.startTime).toBe("2026-06-21T08:00:00-07:00");
  });

  it("uses real daylight overlap to keep running out of overnight windows when daylight exists", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-10-10T01:00:00-07:00",
          endTime: "2026-10-10T02:00:00-07:00",
          temperatureF: 62,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-10-10T02:00:00-07:00",
          endTime: "2026-10-10T03:00:00-07:00",
          temperatureF: 62,
          isDaytime: false
        }),
        buildHour({
          startTime: "2026-10-10T07:30:00-07:00",
          endTime: "2026-10-10T08:30:00-07:00",
          temperatureF: 60,
          isDaytime: true
        }),
        buildHour({
          startTime: "2026-10-10T08:30:00-07:00",
          endTime: "2026-10-10T09:30:00-07:00",
          temperatureF: 61,
          isDaytime: true
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "running",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(
      mergeHoursIntoWindows(hours),
      hours,
      "24h",
      testTimeZone,
      "running",
      {
        latitude: 34.0522,
        longitude: -118.2437
      }
    );

    expect(selected.bestWindow?.startTime).toBe("2026-10-10T07:30:00-07:00");
  });

  it("handles windows crossing midnight safely for daylight overlap", () => {
    const overlapRatio = getDaylightOverlapRatio(
      "2026-06-21T23:30:00-07:00",
      "2026-06-22T01:30:00-07:00",
      34.0522,
      -118.2437,
      "America/Los_Angeles"
    );

    expect(overlapRatio).toBe(0);
    expect(
      isMostlyDaylightWindow(
        "2026-06-21T23:30:00-07:00",
        "2026-06-22T01:30:00-07:00",
        34.0522,
        -118.2437,
        "America/Los_Angeles"
      )
    ).toBe(false);
  });

  it("falls back safely when coordinates are missing", () => {
    expect(() =>
      getDaylightOverlapRatio(
        "2026-04-24T09:00:00-07:00",
        "2026-04-24T10:00:00-07:00",
        undefined,
        undefined,
        testTimeZone,
        { fallbackIsDaytime: true }
      )
    ).not.toThrow();

    expect(
      getDaylightOverlapRatio(
        "2026-04-24T09:00:00-07:00",
        "2026-04-24T10:00:00-07:00",
        undefined,
        undefined,
        testTimeZone,
        { fallbackIsDaytime: true }
      )
    ).toBe(1);
  });

  it("classifies daylight window tiers correctly", () => {
    expect(
      getDaylightWindowTier(
        "2026-06-21T12:00:00-07:00",
        "2026-06-21T14:00:00-07:00",
        34.0522,
        -118.2437,
        "America/Los_Angeles"
      )
    ).toBe("daylight");

    expect(
      getDaylightWindowTier(
        "2026-06-21T19:30:00-07:00",
        "2026-06-21T21:30:00-07:00",
        34.0522,
        -118.2437,
        "America/Los_Angeles"
      )
    ).toBe("mixed-light");

    expect(
      getDaylightWindowTier(
        "2026-06-21T23:30:00-07:00",
        "2026-06-22T01:30:00-07:00",
        34.0522,
        -118.2437,
        "America/Los_Angeles"
      )
    ).toBe("night");
  });

  it("does not repeat the main factor in the Why panel", () => {
    const markup = renderToStaticMarkup(
      createElement(WhyPanel, {
        result: {
          location: {
            postalCode: "10001",
            label: "New York, NY",
            latitude: 40.7128,
            longitude: -74.006,
            timeZone: "America/New_York"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Tue, Apr 28 8:00 AM - 10:00 AM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            emphasis: "normal",
            mainFactor: "low precipitation risk"
          },
          bestWindow: {
            startTime: "2026-04-28T08:00:00-04:00",
            endTime: "2026-04-28T10:00:00-04:00",
            classification: "good",
            rating: "Good",
            averageScore: 88,
            reasons: ["low precip risk", "lighter wind near 8 mph", "comfortable around 67F"],
            hours: []
          },
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-28T00:00:00-04:00"
        }
      })
    );

    expect(markup).toContain("Main factor: low precipitation risk");
    expect(markup).not.toContain("low precip risk");
  });

  it("does not render Conditions stable when no daylight window is the decision", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 38.627,
            longitude: -90.1994,
            timeZone: "America/Chicago"
          },
          planningMode: "flexible",
          activity: "kidsSports",
          horizon: "tonight",
          summary: {
            recommendation: "No good daylight window tonight. Try Next 24 hours.",
            heading: "No good daylight window tonight",
            confidence: "Low",
            confidenceExplanation: "This timeframe is narrow or nearly over, so timing is less reliable.",
            explanation: "Try Next 24 hours.",
            messageType: "daylight_limited",
            emphasis: "caution",
            decisionChip: "No daylight window",
            riskTrend: "Conditions stable",
            mainFactor: "no usable daylight window"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-28T00:00:00-05:00"
        }
      })
    );

    expect(markup).toContain("No daylight window");
    expect(markup).not.toContain("Conditions stable");
  });

  it("renders the updated score guide wording", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({}),
            score: 82,
            classification: "good",
            rating: "Good",
            reasons: ["comfortable around 68F"],
            breakdown: {
              comfort: 100,
              precipitation: 100,
              wind: 100,
              humidity: 90,
              visibility: 100,
              alerts: 100,
              aqi: 100
            },
            airQuality: null,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none",
            alertLabel: null,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain(
      "Severe hazards may lower scores significantly, including warnings, tornado risk, severe storms, flooding, ice, extreme heat/cold, and dangerous AQI."
    );
  });

  it("shows AQI in hourly cards when AQI is moderate or worse", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              aqi: 81,
              aqiCategory: "Moderate"
            }),
            score: 68,
            classification: "caution",
            rating: "Caution",
            reasons: ["moderate air quality"],
            breakdown: {
              comfort: 95,
              precipitation: 100,
              wind: 90,
              humidity: 80,
              visibility: 100,
              alerts: 100,
              aqi: 72
            },
            airQuality: {
              parameter: "US AQI",
              aqi: 81,
              category: "Moderate",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            hasAqiImpact: true,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none",
            alertLabel: null,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("AQI 81 Mod.");
  });

  it("uses a compact USG AQI label in hourly cards", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              aqi: 112,
              aqiCategory: "Unhealthy for Sensitive Groups"
            }),
            score: 54,
            classification: "caution",
            rating: "Caution",
            reasons: ["air quality may affect sensitive groups"],
            breakdown: {
              comfort: 95,
              precipitation: 100,
              wind: 90,
              humidity: 80,
              visibility: 100,
              alerts: 100,
              aqi: 40
            },
            airQuality: {
              parameter: "US AQI",
              aqi: 112,
              category: "Unhealthy for Sensitive Groups",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            hasAqiImpact: true,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none",
            alertLabel: null,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).toContain("AQI 112 USG");
    expect(markup).not.toContain("Unhealthy for Sensitive Groups");
  });

  it("hides AQI in hourly cards when AQI is good and not influencing the score", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              aqi: 42,
              aqiCategory: "Good"
            }),
            score: 88,
            classification: "good",
            rating: "Good",
            reasons: ["comfortable around 68F"],
            breakdown: {
              comfort: 100,
              precipitation: 100,
              wind: 100,
              humidity: 88,
              visibility: 100,
              alerts: 100,
              aqi: 100
            },
            airQuality: {
              parameter: "US AQI",
              aqi: 42,
              category: "Good",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            hasAqiImpact: false,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none",
            alertLabel: null,
            alertContext: null
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).not.toContain("AQI 42");
  });

  it("shows AQI in hourly cards when AQI is part of the selected-window story", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: buildHour({
              aqi: 42,
              aqiCategory: "Good"
            }),
            score: 84,
            classification: "good",
            rating: "Good",
            reasons: ["comfortable around 68F"],
            breakdown: {
              comfort: 100,
              precipitation: 100,
              wind: 100,
              humidity: 88,
              visibility: 100,
              alerts: 100,
              aqi: 100
            },
            airQuality: {
              parameter: "US AQI",
              aqi: 42,
              category: "Good",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9,
              source: "Open-Meteo Air Quality"
            },
            hasAqiImpact: false,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none",
            alertLabel: null,
            alertContext: null
          }
        ],
        timeZone: testTimeZone,
        highlightAqi: true
      })
    );

    expect(markup).toContain("AQI 42");
  });

  it("uses AQI-focused insight when later air quality worsens", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T07:00:00-07:00",
          endTime: "2026-04-24T08:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T12:00:00-07:00",
          endTime: "2026-04-24T13:00:00-07:00"
        }),
        buildHour({
          startTime: "2026-04-24T13:00:00-07:00",
          endTime: "2026-04-24T14:00:00-07:00"
        })
      ],
      alerts: [],
      airQuality: null,
      airQualityByHour: new Map([
        ["2026-04-24 07", { parameter: "US AQI", aqi: 42, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 7, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 08", { parameter: "US AQI", aqi: 45, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 8, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 09", { parameter: "US AQI", aqi: 48, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 9, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 10", { parameter: "US AQI", aqi: 50, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 10, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 12", { parameter: "US AQI", aqi: 112, category: "Unhealthy for Sensitive Groups", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 12, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 13", { parameter: "US AQI", aqi: 118, category: "Unhealthy for Sensitive Groups", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 13, source: "Open-Meteo Air Quality" }]
      ]),
      activity: "walking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(mergeHoursIntoWindows(hours), hours, "24h", testTimeZone, "walking");
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: { primary: hours[0].airQuality ?? null, available: true },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "walking"
    );

    expect(summary.highlightInsight).toBe(
      "Best conditions occur before AQI reaches Unhealthy for Sensitive Groups."
    );
    expect(summary.mainFactor).toBe("AQI stays lower during this window");
  });

  it("prioritizes thunderstorms over AQI in the insight line when both worsen later", () => {
    const hours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T07:00:00-07:00",
          endTime: "2026-04-24T08:00:00-07:00",
          shortForecast: "Clear"
        }),
        buildHour({
          startTime: "2026-04-24T08:00:00-07:00",
          endTime: "2026-04-24T09:00:00-07:00",
          shortForecast: "Clear"
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Chance of T-storms",
          detailedForecast: "Thunderstorms possible late morning."
        })
      ],
      alerts: [],
      airQuality: null,
      airQualityByHour: new Map([
        ["2026-04-24 07", { parameter: "US AQI", aqi: 40, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 7, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 08", { parameter: "US AQI", aqi: 42, category: "Good", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 8, source: "Open-Meteo Air Quality" }],
        ["2026-04-24 10", { parameter: "US AQI", aqi: 118, category: "Unhealthy for Sensitive Groups", reportingArea: "Open-Meteo", stateCode: "", dateObserved: "2026-04-24", hourObserved: 10, source: "Open-Meteo Air Quality" }]
      ]),
      activity: "walking",
      timeZone: testTimeZone
    });
    const selected = selectBestWindows(mergeHoursIntoWindows(hours), hours, "24h", testTimeZone, "walking");
    const summary = buildSummary(
      {
        bestWindow: selected.bestWindow,
        alerts: [],
        airQuality: { primary: hours[0].airQuality ?? null, available: true },
        hourly: hours,
        nextAvailableWindow: null
      },
      "24h",
      testTimeZone,
      "walking"
    );

    expect(summary.highlightInsight).toContain("thunderstorms return");
  });

  it("shows the no daylight message only once on the card", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 38.627,
            longitude: -90.1994,
            timeZone: "America/Chicago"
          },
          planningMode: "flexible",
          activity: "kidsSports",
          horizon: "tonight",
          summary: {
            recommendation: "No good daylight window tonight. Try Next 24 hours.",
            heading: "No good daylight window tonight",
            confidence: "Low",
            confidenceExplanation: "This timeframe is narrow or nearly over, so timing is less reliable.",
            explanation: "Try Next 24 hours.",
            messageType: "daylight_limited",
            emphasis: "caution",
            decisionChip: "No daylight window",
            contextNote: "Weather improves during daylight later.",
            mainFactor: "no usable daylight window"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-28T00:00:00-05:00"
        }
      })
    );

    expect(markup.split("No good daylight window tonight. Try Next 24 hours.")).toHaveLength(2);
  });

  it("adds a contextual label to an early-morning secondary option", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "10001",
            label: "New York, NY",
            latitude: 40.7128,
            longitude: -74.006,
            timeZone: "America/New_York"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Tue, Apr 28 9:00 AM - 11:00 AM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            emphasis: "normal",
            mainFactor: "comfortable conditions"
          },
          bestWindow: {
            startTime: "2026-04-28T09:00:00-04:00",
            endTime: "2026-04-28T11:00:00-04:00",
            classification: "good",
            rating: "Good",
            averageScore: 90,
            reasons: ["comfortable around 67F"],
            hours: []
          },
          secondaryWindow: {
            startTime: "2026-04-29T05:00:00-04:00",
            endTime: "2026-04-29T07:00:00-04:00",
            classification: "good",
            rating: "Good",
            averageScore: 83,
            reasons: ["low precip risk"],
            hours: [],
            daylightTier: "mixed-light"
          },
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-28T00:00:00-04:00"
        }
      })
    );

    expect(markup).toContain("Secondary option:");
    expect(markup).toContain("(early morning)");
  });

  it("does not call another daylight window better when the selected window is already a good daylight window", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "85001",
            label: "Phoenix, AZ",
            latitude: 33.4484,
            longitude: -112.074,
            timeZone: "America/Phoenix"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Thu, Apr 24 1:00 PM - 5:00 PM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            mainFactor: "comfortable conditions"
          },
          bestWindow: {
            startTime: "2026-04-24T13:00:00-07:00",
            endTime: "2026-04-24T17:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 90,
            reasons: ["comfortable around 74F"],
            hours: [],
            daylightTier: "daylight"
          },
          secondaryWindow: {
            startTime: "2026-04-24T17:00:00-07:00",
            endTime: "2026-04-24T20:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 86,
            reasons: ["comfortable around 72F"],
            hours: [],
            daylightTier: "daylight"
          },
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain("Another good option:");
    expect(markup).not.toContain("A better daylight option is");
  });

  it("does not call a later lower-score AQI-worse window better", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "85001",
            label: "Phoenix, AZ",
            latitude: 33.4484,
            longitude: -112.074,
            timeZone: "America/Phoenix"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window: Thu, Apr 24 1:00 PM - 5:00 PM",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            mainFactor: "AQI stays lower during this window",
            highlightInsight: "Best window ends before air quality worsens later."
          },
          bestWindow: {
            startTime: "2026-04-24T13:00:00-07:00",
            endTime: "2026-04-24T17:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 90,
            reasons: ["AQI stays lower during this window"],
            hours: [
              {
                forecast: buildHour({ aqi: 48, aqiCategory: "Good" }),
                score: 90,
                classification: "good",
                rating: "Good",
                reasons: ["comfortable around 76F"],
                breakdown: { comfort: 100, precipitation: 100, wind: 100, humidity: 90, visibility: 100, alerts: 100, aqi: 100 },
                airQuality: {
                  parameter: "US AQI",
                  aqi: 48,
                  category: "Good",
                  reportingArea: "Open-Meteo",
                  stateCode: "",
                  dateObserved: "2026-04-24",
                  hourObserved: 13,
                  source: "Open-Meteo Air Quality"
                },
                hasRelevantAlert: false,
                alertImpact: "none",
                activeAlertImpact: "none",
                recentAlertImpact: "none"
              }
            ],
            daylightTier: "daylight"
          },
          secondaryWindow: {
            startTime: "2026-04-24T17:00:00-07:00",
            endTime: "2026-04-24T20:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 82,
            reasons: ["air quality may affect sensitive groups"],
            hours: [
              {
                forecast: buildHour({ aqi: 112, aqiCategory: "Unhealthy for Sensitive Groups", startTime: "2026-04-24T17:00:00-07:00", endTime: "2026-04-24T18:00:00-07:00" }),
                score: 82,
                classification: "good",
                rating: "Good",
                reasons: ["air quality may affect sensitive groups"],
                breakdown: { comfort: 100, precipitation: 100, wind: 100, humidity: 90, visibility: 100, alerts: 100, aqi: 40 },
                airQuality: {
                  parameter: "US AQI",
                  aqi: 112,
                  category: "Unhealthy for Sensitive Groups",
                  reportingArea: "Open-Meteo",
                  stateCode: "",
                  dateObserved: "2026-04-24",
                  hourObserved: 17,
                  source: "Open-Meteo Air Quality"
                },
                hasRelevantAlert: false,
                alertImpact: "none",
                activeAlertImpact: "none",
                recentAlertImpact: "none"
              }
            ],
            daylightTier: "daylight"
          },
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: true },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain("Another workable option:");
    expect(markup).not.toContain("A better daylight option is");
  });

  it("can still show a better daylight option when the selected window is a daylight fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(RecommendationCard, {
        result: {
          location: {
            postalCode: "63101",
            label: "St. Louis, MO",
            latitude: 38.627,
            longitude: -90.1994,
            timeZone: "America/Chicago"
          },
          planningMode: "flexible",
          activity: "kidsSports",
          horizon: "24h",
          summary: {
            recommendation: "Best available window: Thu, Apr 24 5:00 AM - 7:00 AM",
            heading: "Best available window",
            confidence: "Low",
            confidenceExplanation: "Some risk factors are present, but timing is fairly clear.",
            explanation: "Conditions are not ideal, but this is the most workable time.",
            messageType: "fallback",
            mainFactor: "no ideal daylight window found"
          },
          bestWindow: {
            startTime: "2026-04-24T05:00:00-05:00",
            endTime: "2026-04-24T07:00:00-05:00",
            classification: "caution",
            rating: "Caution",
            averageScore: 66,
            reasons: ["limited daylight window before storm risk returns"],
            hours: [],
            daylightTier: "mixed-light",
            selectedAsDaylightFallback: true
          },
          secondaryWindow: {
            startTime: "2026-04-24T16:00:00-05:00",
            endTime: "2026-04-24T18:00:00-05:00",
            classification: "good",
            rating: "Good",
            averageScore: 83,
            reasons: ["low precip risk"],
            hours: [],
            daylightTier: "daylight"
          },
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: false },
          generatedAt: "2026-04-24T00:00:00-05:00"
        }
      })
    );

    expect(markup).toContain("A better daylight option is");
  });

  it("removes duplicate feels-like reasons when AQI is the actual main factor", () => {
    const markup = renderToStaticMarkup(
      createElement(WhyPanel, {
        result: {
          location: {
            postalCode: "85001",
            label: "Phoenix, AZ",
            latitude: 33.4484,
            longitude: -112.074,
            timeZone: "America/Phoenix"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            mainFactor: "AQI stays lower during this window",
            highlightInsight: "Best conditions occur before AQI reaches Unhealthy for Sensitive Groups."
          },
          bestWindow: {
            startTime: "2026-04-24T07:00:00-07:00",
            endTime: "2026-04-24T11:00:00-07:00",
            classification: "good",
            rating: "Good",
            averageScore: 88,
            reasons: [
              "AQI stays lower during this window",
              "feels like 83F",
              "feels like 81F",
              "comfortable around 79F"
            ],
            hours: []
          },
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: { primary: null, available: true },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain("Main factor: AQI stays lower during this window");
    expect(markup).not.toContain("feels like 83F");
    expect(markup).not.toContain("feels like 81F");
    expect(markup).not.toContain("comfortable around 79F");
  });

  it("resolves a ZIP code and keeps a readable ZIP plus city/state label", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          "post code": "75217",
          country: "United States",
          "country abbreviation": "US",
          places: [
            {
              "place name": "Dallas",
              longitude: "-96.7000",
              state: "Texas",
              latitude: "32.7100",
              "state abbreviation": "TX"
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const resolved = await resolveLocationQuery("75217");

    expect(resolved.city).toBe("Dallas");
    expect(resolved.state).toBe("TX");
    expect(resolved.postalCode).toBe("75217");
    expect(resolved.inputLabel).toBe("75217 - Dallas, TX");
  });

  it("resolves a city/state query and returns a readable city/state label", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              name: "Stockton",
              latitude: 37.9577,
              longitude: -121.2908,
              country_code: "US",
              admin1: "California"
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const resolved = await resolveLocationQuery("Stockton, CA");

    expect(resolved.city).toBe("Stockton");
    expect(resolved.state).toBe("CA");
    expect(resolved.postalCode).toBeNull();
    expect(resolved.inputLabel).toBe("Stockton, CA");
  });

  it("shows a friendly error for an invalid city/state query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(resolveLocationQuery("NotARealTown, CA")).rejects.toThrow(
      "We couldn't find that city and state. Please enter a valid U.S. ZIP code or City, ST."
    );
  });

  it("formats city names with apostrophes and common casing patterns", () => {
    expect(titleCase("o'fallon")).toBe("O'Fallon");
    expect(titleCase("mcallen")).toBe("McAllen");
    expect(titleCase("st. louis")).toBe("St. Louis");
    expect(titleCase("los angeles")).toBe("Los Angeles");
  });

  it("supports planned events that cross midnight with explicit end date", () => {
    const resolved = resolveEventWindow({
      eventStartDate: "2026-04-24",
      eventEndDate: "2026-04-25",
      eventStartTime: "22:00",
      eventEndTime: "02:00",
      timeZone: "America/Chicago"
    });

    expect(new Date(resolved.endTime).getTime()).toBeGreaterThan(new Date(resolved.startTime).getTime());
  });

  it("shows a validation error when the event end is before the start", () => {
    expect(() =>
      resolveEventWindow({
        eventStartDate: "2026-04-24",
        eventEndDate: "2026-04-24",
        eventStartTime: "18:00",
        eventEndTime: "16:00",
        timeZone: "America/Chicago"
      })
    ).toThrow("Please make sure the event end date and time are after the start.");
  });

  it("reveals results only after loading completes with a new successful result", () => {
    expect(
      shouldRevealResults({
        isLoading: true,
        hasResult: true,
        completedRunId: 1,
        revealedRunId: null
      })
    ).toBe(false);

    expect(
      shouldRevealResults({
        isLoading: false,
        hasResult: false,
        completedRunId: 1,
        revealedRunId: null
      })
    ).toBe(false);

    expect(
      shouldRevealResults({
        isLoading: false,
        hasResult: true,
        completedRunId: 1,
        revealedRunId: null
      })
    ).toBe(true);
  });

  it("does not double-trigger reveal for the same result but triggers again for a rerun", () => {
    expect(
      shouldRevealResults({
        isLoading: false,
        hasResult: true,
        completedRunId: 2,
        revealedRunId: 2
      })
    ).toBe(false);

    expect(
      shouldRevealResults({
        isLoading: false,
        hasResult: true,
        completedRunId: 3,
        revealedRunId: 2
      })
    ).toBe(true);
  });

  it("uses alert_blocked instead of daylight_limited when active warnings block a Tonight daylight-required case", () => {
    const summary = buildSummary(
      {
        bestWindow: null,
        alerts: [
          {
            id: "warn-1",
            event: "Severe Thunderstorm Warning",
            severity: "Severe",
            headline: "Warning",
            description: "Severe storms.",
            onset: "2026-04-24T19:00:00-05:00",
            ends: "2026-04-24T22:00:00-05:00"
          }
        ],
        airQuality: {
          primary: null,
          available: false
        },
        hourly: [
          {
            forecast: buildHour({
              startTime: "2026-04-24T20:00:00-05:00",
              endTime: "2026-04-24T21:00:00-05:00",
              isDaytime: false
            }),
            score: 12,
            classification: "avoid",
            rating: "Avoid",
            reasons: ["Severe thunderstorm warning in effect"],
            breakdown: {
              comfort: 92,
              precipitation: 90,
              wind: 80,
              humidity: 80,
              visibility: 80,
              alerts: 10,
              aqi: 100
            },
            airQuality: null,
            hasRelevantAlert: true,
            hasAqiImpact: false,
            alertImpact: "severe",
            activeAlertImpact: "severe",
            recentAlertImpact: "none",
            alertLabel: "alert",
            alertContext: "active-alert"
          }
        ],
        nextAvailableWindow: null
      },
      "tonight",
      "America/Chicago",
      "kidsSports",
      {
        latitude: 38.627,
        longitude: -90.1994
      }
    );

    expect(summary.messageType).toBe("alert_blocked");
    expect(summary.heading).toBe("Outdoor conditions are not safe due to active warnings");
    expect(summary.mainFactor).toBe("active weather warnings");
    expect(summary.confidenceExplanation).toBe(
      "Active warnings or watches are affecting this period. Follow official alerts."
    );
  });

  it("uses event-specific caution wording instead of flexible fallback wording", () => {
    const scoredHours = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T09:00:00-07:00",
          endTime: "2026-04-24T10:00:00-07:00",
          shortForecast: "Thunderstorms likely",
          detailedForecast: "Thunderstorms likely late morning."
        }),
        buildHour({
          startTime: "2026-04-24T10:00:00-07:00",
          endTime: "2026-04-24T11:00:00-07:00",
          shortForecast: "Partly Sunny",
          detailedForecast: "Partly sunny."
        })
      ],
      alerts: [],
      airQuality: null,
      activity: "social",
      timeZone: testTimeZone
    });
    const eventResult = scorePlannedEvent({
      scoredHours,
      eventDate: "2026-04-24",
      eventStartTime: "09:00",
      eventEndTime: "11:00",
      timeZone: testTimeZone,
      activity: "social",
      suggestAlternates: false,
      now: new Date("2026-04-24T00:00:00-07:00")
    });
    const summary = buildEventSummary({
      eventResult,
      timeZone: testTimeZone,
      hourly: scoredHours
    });

    expect(eventResult.rating).toBe("Caution");
    expect(summary.heading).toBe("Use caution for this event");
    expect(summary.heading).not.toBe("Best available window");
  });

  it("keeps only the specific alert reason when one is available", () => {
    const [hour] = scoreForecastHours({
      hours: [
        buildHour({
          startTime: "2026-04-24T18:00:00-07:00",
          endTime: "2026-04-24T19:00:00-07:00"
        })
      ],
      alerts: [
        {
          id: "warning-specific",
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: "Warning",
          description: "Severe storms.",
          onset: "2026-04-24T17:30:00-07:00",
          ends: "2026-04-24T19:30:00-07:00"
        }
      ],
      airQuality: null,
      activity: "exercise"
    });

    expect(hour.reasons).toContain("Severe thunderstorm warning in effect");
    expect(hour.reasons).not.toContain("active severe weather alert");
  });

  it("renders current air quality as a compact AQI line", () => {
    const markup = renderToStaticMarkup(
      createElement(AirQualityPanel, {
        result: {
          location: {
            postalCode: "94103",
            label: "San Francisco, CA",
            latitude: 37.7749,
            longitude: -122.4194,
            timeZone: "America/Los_Angeles"
          },
          planningMode: "flexible",
          activity: "walking",
          horizon: "24h",
          summary: {
            recommendation: "Recommended window",
            heading: "Recommended window",
            confidence: "High",
            confidenceExplanation: "Few weather risks are present in this time range.",
            explanation: "Clear conditions.",
            mainFactor: "comfortable conditions"
          },
          bestWindow: null,
          secondaryWindow: null,
          nextAvailableWindow: null,
          eventResult: null,
          cautionWindows: [],
          avoidWindows: [],
          hourly: [],
          alerts: [],
          alertsInfo: { available: true },
          airQuality: {
            primary: {
              parameter: "US AQI",
              aqi: 29,
              category: "Good",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9
            },
            available: true
          },
          generatedAt: "2026-04-24T00:00:00-07:00"
        }
      })
    );

    expect(markup).toContain(">29<");
    expect(markup).toContain("Good");
    expect(markup).toContain("US AQI");
    expect(markup).not.toContain("AQI 29");
    expect(markup).not.toContain("AQI: 29");
  });

  it("does not show an AQI 50 hourly badge when it stayed Good and did not affect scoring", () => {
    const markup = renderToStaticMarkup(
      createElement(HourlyTimeline, {
        hours: [
          {
            forecast: {
              ...buildHour({}),
              aqi: 50,
              aqiCategory: "Good"
            },
            score: 88,
            classification: "good",
            rating: "Good",
            reasons: ["comfortable around 68F"],
            breakdown: {
              comfort: 100,
              precipitation: 95,
              wind: 90,
              humidity: 88,
              visibility: 100,
              alerts: 100,
              aqi: 100
            },
            airQuality: {
              parameter: "US AQI",
              aqi: 50,
              category: "Good",
              reportingArea: "Open-Meteo",
              stateCode: "",
              dateObserved: "2026-04-24",
              hourObserved: 9
            },
            hasAqiImpact: false,
            hasRelevantAlert: false,
            alertImpact: "none",
            activeAlertImpact: "none",
            recentAlertImpact: "none"
          }
        ],
        timeZone: testTimeZone
      })
    );

    expect(markup).not.toContain("AQI 50");
  });
});
