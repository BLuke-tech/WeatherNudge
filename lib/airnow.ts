import { AirQualityReading } from "@/lib/types";
import { titleCase } from "@/lib/utils";

interface AirNowObservation {
  DateObserved: string;
  HourObserved?: number;
  LocalTimeZone?: string;
  ReportingArea: string;
  StateCode: string;
  ParameterName: string;
  AQI: number;
  Category?: {
    Number?: number;
    Name?: string;
  };
}

export async function fetchAirQuality(
  latitude: number,
  longitude: number
): Promise<{ primary: AirQualityReading | null; available: boolean; note?: string }> {
  const apiKey = process.env.AIRNOW_API_KEY;

  if (!apiKey) {
    return {
      primary: null,
      available: false,
      note: "AirNow is not configured."
    };
  }

  try {
    const url = new URL("https://www.airnowapi.org/aq/observation/latLong/current/");
    url.searchParams.set("format", "application/json");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("distance", "25");
    url.searchParams.set("API_KEY", apiKey);

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
        note: `AQI data could not be loaded right now (status ${response.status}).`
      };
    }

    const data = (await response.json()) as AirNowObservation[];
    const preferred =
      data.find((item) => item.ParameterName === "PM2.5") ??
      data.find((item) => item.ParameterName === "O3") ??
      data[0];

    if (!preferred) {
      return {
        primary: null,
        available: false,
        note: "AirNow returned no nearby AQI observations."
      };
    }

    return {
      primary: {
        parameter: preferred.ParameterName,
        aqi: preferred.AQI,
        category: titleCase(preferred.Category?.Name ?? "Unknown"),
        reportingArea: preferred.ReportingArea,
        stateCode: preferred.StateCode,
        dateObserved: preferred.DateObserved,
        hourObserved: preferred.HourObserved ?? null,
        source: "AirNow"
      },
      available: true
    };
  } catch {
    return {
      primary: null,
      available: false,
      note: "AQI data is temporarily unavailable, so this recommendation uses weather only."
    };
  }
}
