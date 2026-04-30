import { Coordinates } from "@/lib/types";
import { isValidCityStateQuery, isValidZipCode, titleCase } from "@/lib/utils";
import { zipToLatLon } from "@/lib/zipToLatLon";

interface OpenMeteoGeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
}

interface OpenMeteoGeocodeResponse {
  results?: OpenMeteoGeocodeResult[];
}

const usStateNames: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia"
};

function parseCityStateQuery(query: string) {
  const [cityRaw, stateRaw] = query.split(",");
  const city = cityRaw?.trim();
  const state = stateRaw?.trim().toUpperCase();

  if (!city || !state || !(state in usStateNames)) {
    throw new Error("Please enter a U.S. ZIP code or City, ST.");
  }

  return {
    city,
    state,
    stateName: usStateNames[state]
  };
}

export async function geocodeCityState(query: string): Promise<Coordinates> {
  if (!isValidCityStateQuery(query)) {
    throw new Error("Please enter a U.S. ZIP code or City, ST.");
  }

  const { city, state, stateName } = parseCityStateQuery(query);
  const searchParams = new URLSearchParams({
    name: city,
    count: "10",
    language: "en",
    format: "json",
    countryCode: "US"
  });

  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?${searchParams.toString()}`,
    {
      headers: {
        Accept: "application/json"
      },
      next: { revalidate: 3600 }
    }
  );

  if (!response.ok) {
    throw new Error("We couldn't resolve that city and state right now. Please try ZIP code or City, ST.");
  }

  const data = (await response.json()) as OpenMeteoGeocodeResponse;
  const matchingResult =
    data.results?.find((result) => {
      const resultCity = result.name.trim().toLowerCase();
      const targetCity = city.trim().toLowerCase();
      const resultState = result.admin1?.trim().toLowerCase();
      return (
        resultCity === targetCity &&
        resultState === stateName.toLowerCase()
      );
    }) ??
    data.results?.find((result) => result.admin1?.trim().toLowerCase() === stateName.toLowerCase());

  if (!matchingResult) {
    throw new Error("We couldn't find that city and state. Please enter a valid U.S. ZIP code or City, ST.");
  }

  return {
    latitude: matchingResult.latitude,
    longitude: matchingResult.longitude,
    city: titleCase(matchingResult.name),
    state,
    postalCode: null,
    countryCode: matchingResult.country_code,
    inputLabel: `${titleCase(matchingResult.name)}, ${state}`
  };
}

export async function resolveLocationQuery(query: string): Promise<Coordinates> {
  const trimmed = query.trim();

  if (isValidZipCode(trimmed)) {
    const resolved = await zipToLatLon(trimmed);
    return {
      ...resolved,
      inputLabel: resolved.city && resolved.state
        ? `${resolved.postalCode} - ${resolved.city}, ${resolved.state}`
        : resolved.postalCode ?? trimmed
    };
  }

  return geocodeCityState(trimmed);
}
