import { ForecastHour, WeatherAlert } from "@/lib/types";
import { safeNumber, titleCase } from "@/lib/utils";

const USER_AGENT =
  process.env.NWS_USER_AGENT ??
  "WeatherNudge (contact: developer@example.com)";

function nwsHeaders() {
  return {
    Accept: "application/geo+json",
    "User-Agent": USER_AGENT
  };
}

function extractWindMph(windSpeed: string | null | undefined) {
  if (!windSpeed) return null;
  const match = windSpeed.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function celsiusToFahrenheit(value: number | null) {
  if (value === null) return null;
  return Math.round((value * 9) / 5 + 32);
}

function metersToMiles(value: number | null) {
  if (value === null) return null;
  return Number((value / 1609.344).toFixed(1));
}

function kilometersPerHourToMilesPerHour(value: number | null) {
  if (value === null) return null;
  return Math.round(value * 0.621371);
}

function parseDurationToHours(duration: string) {
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!match) return 1;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const totalHours = days * 24 + hours + (minutes > 0 ? minutes / 60 : 0);

  return totalHours || 1;
}

type GridValue = {
  validTime: string;
  value: number | null;
};

type GridPoint = {
  start: number;
  end: number;
  value: number | null;
};

function expandGridValues(values: GridValue[] | undefined): GridPoint[] {
  if (!values?.length) return [];

  return values
    .map((entry) => {
      const [startRaw, durationRaw] = entry.validTime.split("/");
      const start = new Date(startRaw).getTime();
      const hours = parseDurationToHours(durationRaw ?? "PT1H");
      const end = start + hours * 60 * 60 * 1000;

      return {
        start,
        end,
        value: safeNumber(entry.value)
      };
    })
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end));
}

function findGridValue(points: GridPoint[], isoTime: string) {
  const target = new Date(isoTime).getTime();
  const match = points.find((point) => target >= point.start && target < point.end);
  return match?.value ?? null;
}

function textFlags(period: {
  shortForecast?: string;
  detailedForecast?: string | null;
}) {
  const text = [period.shortForecast, period.detailedForecast].filter(Boolean).join(" ").toLowerCase();

  return {
    fogMentioned:
      text.includes("dense fog") ||
      text.includes("patchy fog") ||
      text.includes("areas of fog") ||
      /\bfog\b/.test(text),
    smokeMentioned:
      text.includes("dense smoke") ||
      text.includes("wildfire smoke") ||
      text.includes("areas of smoke") ||
      text.includes("smoke") ||
      text.includes("haze")
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: nwsHeaders(),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`NWS request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchNwsForecast(latitude: number, longitude: number) {
  const pointData = await fetchJson<{
    properties?: {
      forecastHourly?: string;
      forecastGridData?: string;
      timeZone?: string;
    };
  }>(`https://api.weather.gov/points/${latitude},${longitude}`);

  const forecastUrl = pointData.properties?.forecastHourly;
  const gridDataUrl = pointData.properties?.forecastGridData;
  const timeZone = pointData.properties?.timeZone ?? "UTC";

  if (!forecastUrl) {
    throw new Error("NWS did not return an hourly forecast endpoint for this ZIP.");
  }

  const forecastData = await fetchJson<{
    properties?: {
      periods?: Array<{
        startTime: string;
        endTime: string;
        temperature: number;
        temperatureUnit: string;
        windSpeed: string;
        windDirection: string;
        shortForecast: string;
        detailedForecast?: string;
        probabilityOfPrecipitation?: {
          value: number | null;
        };
        relativeHumidity?: {
          value: number | null;
        };
        isDaytime: boolean;
      }>;
    };
  }>(forecastUrl);

  const gridData = gridDataUrl
    ? await fetchJson<{
        properties?: {
          apparentTemperature?: {
            values?: GridValue[];
          };
          windGust?: {
            values?: GridValue[];
          };
          relativeHumidity?: {
            values?: GridValue[];
          };
          dewpoint?: {
            values?: GridValue[];
          };
          visibility?: {
            values?: GridValue[];
          };
        };
      }>(gridDataUrl).catch(() => null)
    : null;

  const apparentTemperaturePoints = expandGridValues(
    gridData?.properties?.apparentTemperature?.values
  );
  const windGustPoints = expandGridValues(gridData?.properties?.windGust?.values);
  const relativeHumidityPoints = expandGridValues(
    gridData?.properties?.relativeHumidity?.values
  );
  const dewpointPoints = expandGridValues(gridData?.properties?.dewpoint?.values);
  const visibilityPoints = expandGridValues(gridData?.properties?.visibility?.values);

  const hours: ForecastHour[] =
    forecastData.properties?.periods?.map((period) => {
      const apparentTemperatureRaw = findGridValue(
        apparentTemperaturePoints,
        period.startTime
      );
      const windGustRaw = findGridValue(windGustPoints, period.startTime);
      const relativeHumidityRaw =
        safeNumber(period.relativeHumidity?.value) ??
        findGridValue(relativeHumidityPoints, period.startTime);
      const dewpointRaw = findGridValue(dewpointPoints, period.startTime);
      const visibilityRaw = findGridValue(visibilityPoints, period.startTime);
      const flags = textFlags(period);

      return {
        startTime: period.startTime,
        endTime: period.endTime,
        temperatureF: safeNumber(period.temperature),
        apparentTemperatureF: celsiusToFahrenheit(apparentTemperatureRaw),
        temperatureUnit: period.temperatureUnit ?? "F",
        windSpeedMph: extractWindMph(period.windSpeed),
        windGustMph: kilometersPerHourToMilesPerHour(windGustRaw),
        windDirection: period.windDirection ?? null,
        shortForecast: period.shortForecast ?? "Forecast unavailable",
        detailedForecast: period.detailedForecast ?? null,
        precipitationChance: safeNumber(period.probabilityOfPrecipitation?.value),
        humidity: relativeHumidityRaw,
        relativeHumidityPercent: relativeHumidityRaw,
        dewpointF: celsiusToFahrenheit(dewpointRaw),
        visibilityMiles: metersToMiles(visibilityRaw),
        fogMentioned: flags.fogMentioned,
        smokeMentioned: flags.smokeMentioned,
        isDaytime: Boolean(period.isDaytime)
      };
    }) ?? [];

  if (!hours.length) {
    throw new Error("NWS returned no hourly forecast periods.");
  }

  return {
    hours,
    timeZone
  };
}

export async function fetchNwsAlerts(latitude: number, longitude: number) {
  try {
    const data = await fetchJson<{
      features?: Array<{
        id: string;
        properties?: {
          event?: string;
          severity?: string;
          headline?: string;
          description?: string;
          instruction?: string | null;
          onset?: string | null;
          ends?: string | null;
        };
      }>;
    }>(`https://api.weather.gov/alerts/active?point=${latitude},${longitude}`);

    const alerts: WeatherAlert[] =
      data.features?.map((feature) => ({
        id: feature.id,
        event: feature.properties?.event ?? "Weather alert",
        severity: titleCase(feature.properties?.severity ?? "Unknown"),
        headline: feature.properties?.headline ?? "No headline provided",
        description: feature.properties?.description ?? "No description provided",
        instruction: feature.properties?.instruction ?? null,
        onset: feature.properties?.onset ?? null,
        ends: feature.properties?.ends ?? null
      })) ?? [];

    return {
      alerts,
      available: true
    };
  } catch {
    return {
      alerts: [] as WeatherAlert[],
      available: false,
      note: "Alerts are temporarily unavailable, so the recommendation is based on forecast conditions only."
    };
  }
}
