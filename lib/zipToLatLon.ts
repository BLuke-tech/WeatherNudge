import { Coordinates } from "@/lib/types";

interface ZippopotamResponse {
  "post code": string;
  country: string;
  "country abbreviation": string;
  places: Array<{
    "place name": string;
    longitude: string;
    state: string;
    latitude: string;
    "state abbreviation": string;
  }>;
}

export async function zipToLatLon(zipCode: string): Promise<Coordinates> {
  const response = await fetch(`https://api.zippopotam.us/us/${zipCode}`, {
    headers: {
      Accept: "application/json"
    },
    next: { revalidate: 3600 }
  });

  if (!response.ok) {
    throw new Error("We couldn't find that ZIP code. Please enter a valid U.S. ZIP.");
  }

  const data = (await response.json()) as ZippopotamResponse;
  const place = data.places?.[0];

  if (!place) {
    throw new Error("ZIP lookup returned no matching place.");
  }

  return {
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    city: place["place name"],
    state: place["state abbreviation"],
    postalCode: data["post code"]
  };
}
