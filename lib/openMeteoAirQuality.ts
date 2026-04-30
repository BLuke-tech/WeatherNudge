import { AirQualityReading, ForecastHour } from "@/lib/types";
import { getZonedLocalHourKey } from "@/lib/utils";

interface OpenMeteoAirQualityResponse {
  hourly?: {
    time?: string[];
    us_aqi?: Array<number | null>;
  };
  timezone?: string;
}

export interface OpenMeteoAirQualityResult {
  primary: AirQualityReading | null;
  available: boolean;
  note?: string;
  hourlyReadings: AirQualityReading[];
}

function parseLocalHourKey(localTime: string) {
  const match = localTime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::(\d{2}))?/
  );

  if (!match) {
    return null;
  }

  return {
    dateObserved: `${match[1]}-${match[2]}-${match[3]}`,
    hourObserved: Number(match[4]),
    key: `${match[1]}-${match[2]}-${match[3]} ${match[4]}`
  };
}

export function getOpenMeteoAqiCategory(aqi: number) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

export function normalizeOpenMeteoAirQuality(
  data: OpenMeteoAirQualityResponse
): AirQualityReading[] {
  const times = data.hourly?.time ?? [];
  const values = data.hourly?.us_aqi ?? [];

  return times.flatMap((time, index) => {
    const aqi = values[index];
    const parsed = parseLocalHourKey(time);

    if (aqi === null || aqi === undefined || !Number.isFinite(aqi) || !parsed) {
      return [];
    }

    return [
      {
        parameter: "US AQI",
        aqi: Math.round(aqi),
        category: getOpenMeteoAqiCategory(Math.round(aqi)),
        reportingArea: "Open-Meteo",
        stateCode: "",
        dateObserved: parsed.dateObserved,
        hourObserved: parsed.hourObserved,
        source: "Open-Meteo Air Quality"
      }
    ];
  });
}

export function matchAirQualityToForecastHours(
  hours: ForecastHour[],
  readings: AirQualityReading[],
  timeZone: string
) {
  const byKey = new Map(
    readings.map((reading) => [
      `${reading.dateObserved} ${String(reading.hourObserved ?? 0).padStart(2, "0")}`,
      reading
    ])
  );

  return new Map(
    hours.map((hour) => [
      getZonedLocalHourKey(hour.startTime, timeZone),
      byKey.get(getZonedLocalHourKey(hour.startTime, timeZone)) ?? null
    ])
  );
}

export async function fetchOpenMeteoAirQuality(
  latitude: number,
  longitude: number,
  timeZone: string
): Promise<OpenMeteoAirQualityResult> {
  try {
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("hourly", "us_aqi");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "5");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      return {
        primary: null,
        available: false,
        note: `AQI data could not be loaded right now (status ${response.status}).`,
        hourlyReadings: []
      };
    }

    const data = (await response.json()) as OpenMeteoAirQualityResponse;
    const hourlyReadings = normalizeOpenMeteoAirQuality(data);

    if (!hourlyReadings.length) {
      return {
        primary: null,
        available: false,
        note: "Open-Meteo returned no AQI data for this location right now.",
        hourlyReadings: []
      };
    }

    const currentHourKey = getZonedLocalHourKey(new Date(), timeZone);
    const primary =
      hourlyReadings.find(
        (reading) =>
          `${reading.dateObserved} ${String(reading.hourObserved ?? 0).padStart(2, "0")}` ===
          currentHourKey
      ) ?? hourlyReadings[0];

    return {
      primary,
      available: true,
      hourlyReadings
    };
  } catch {
    return {
      primary: null,
      available: false,
      note: "AQI is unavailable right now, but weather guidance still works.",
      hourlyReadings: []
    };
  }
}
