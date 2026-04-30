import { ActivityMode } from "@/lib/types";
import { getZonedHour } from "@/lib/utils";

export interface ActivityConfig {
  label: string;
  shortDescription: string;
  minPreferredWindowHours: number;
  daylightPreference: "required" | "preferred" | "night-allowed";
  nightSensitivity: 1 | 2 | 3 | 4 | 5;
  precipitationSensitivity: 1 | 2 | 3 | 4 | 5;
  thunderstormSensitivity: 1 | 2 | 3 | 4 | 5;
  heatSensitivity: 1 | 2 | 3 | 4 | 5;
  coldSensitivity: 1 | 2 | 3 | 4 | 5;
  windSensitivity: 1 | 2 | 3 | 4 | 5;
  gustSensitivity: 1 | 2 | 3 | 4 | 5;
  aqiSensitivity: 1 | 2 | 3 | 4 | 5;
  visibilitySensitivity: 1 | 2 | 3 | 4 | 5;
}

export const activityConfigs: Record<ActivityMode, ActivityConfig> = {
  exercise: {
    label: "General exercise",
    shortDescription: "Balanced for outdoor workouts with extra sensitivity to heat, air quality, and storms.",
    minPreferredWindowHours: 2,
    daylightPreference: "preferred",
    nightSensitivity: 3,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 4,
    windSensitivity: 3,
    gustSensitivity: 4,
    aqiSensitivity: 5,
    visibilitySensitivity: 2
  },
  social: {
    label: "Outdoor hangout",
    shortDescription: "Prioritizes lower precipitation risk and generally comfortable, easygoing conditions.",
    minPreferredWindowHours: 2,
    daylightPreference: "night-allowed",
    nightSensitivity: 1,
    precipitationSensitivity: 5,
    thunderstormSensitivity: 5,
    heatSensitivity: 3,
    coldSensitivity: 3,
    windSensitivity: 2,
    gustSensitivity: 2,
    aqiSensitivity: 2,
    visibilitySensitivity: 1
  },
  study: {
    label: "Study outside",
    shortDescription: "Looks for calm, comfortable hours with fewer interruptions from wind or weather.",
    minPreferredWindowHours: 2,
    daylightPreference: "preferred",
    nightSensitivity: 3,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 4,
    coldSensitivity: 4,
    windSensitivity: 3,
    gustSensitivity: 3,
    aqiSensitivity: 3,
    visibilitySensitivity: 2
  },
  walking: {
    label: "Walking / dog walk",
    shortDescription: "Shorter windows can still work, but avoid storms, extreme temperatures, and poor air quality.",
    minPreferredWindowHours: 1,
    daylightPreference: "preferred",
    nightSensitivity: 2,
    precipitationSensitivity: 3,
    thunderstormSensitivity: 5,
    heatSensitivity: 3,
    coldSensitivity: 3,
    windSensitivity: 2,
    gustSensitivity: 2,
    aqiSensitivity: 3,
    visibilitySensitivity: 2
  },
  running: {
    label: "Running",
    shortDescription: "Highly sensitive to heat, air quality, and lightning with shorter windows still acceptable.",
    minPreferredWindowHours: 1,
    daylightPreference: "preferred",
    nightSensitivity: 3,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 4,
    windSensitivity: 3,
    gustSensitivity: 3,
    aqiSensitivity: 5,
    visibilitySensitivity: 2
  },
  biking: {
    label: "Biking",
    shortDescription: "Prefers daylight and is especially sensitive to gusts, visibility, storms, and air quality.",
    minPreferredWindowHours: 2,
    daylightPreference: "required",
    nightSensitivity: 5,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 4,
    coldSensitivity: 4,
    windSensitivity: 5,
    gustSensitivity: 5,
    aqiSensitivity: 4,
    visibilitySensitivity: 4
  },
  hiking: {
    label: "Hiking",
    shortDescription: "Prefers longer daylight windows with strong sensitivity to storms, heat, air quality, and wind.",
    minPreferredWindowHours: 3,
    daylightPreference: "required",
    nightSensitivity: 5,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 4,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 4,
    visibilitySensitivity: 3
  },
  fishing: {
    label: "Fishing",
    shortDescription: "Sensitive to storms, wind, and cold, while still allowing some early or late windows.",
    minPreferredWindowHours: 2,
    daylightPreference: "night-allowed",
    nightSensitivity: 1,
    precipitationSensitivity: 3,
    thunderstormSensitivity: 5,
    heatSensitivity: 3,
    coldSensitivity: 4,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 2,
    visibilitySensitivity: 2
  },
  dining: {
    label: "Outdoor dining",
    shortDescription: "Very sensitive to precipitation, with moderate sensitivity to temperature and wind.",
    minPreferredWindowHours: 2,
    daylightPreference: "preferred",
    nightSensitivity: 1,
    precipitationSensitivity: 5,
    thunderstormSensitivity: 5,
    heatSensitivity: 3,
    coldSensitivity: 3,
    windSensitivity: 3,
    gustSensitivity: 3,
    aqiSensitivity: 2,
    visibilitySensitivity: 1
  },
  kidsSports: {
    label: "Kids sports",
    shortDescription: "Needs daylight and is highly sensitive to storms, heat, wind, and air quality.",
    minPreferredWindowHours: 2,
    daylightPreference: "required",
    nightSensitivity: 5,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 4,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 4,
    visibilitySensitivity: 2
  },
  yardWork: {
    label: "Yard work",
    shortDescription: "Prefers daylight with strong sensitivity to heat, storms, wind, and air quality.",
    minPreferredWindowHours: 2,
    daylightPreference: "required",
    nightSensitivity: 5,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 4,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 4,
    visibilitySensitivity: 2
  },
  outdoorWork: {
    label: "Outdoor work",
    shortDescription: "Looks for steadier daylight windows with strong sensitivity to heat, cold, storms, and AQI.",
    minPreferredWindowHours: 3,
    daylightPreference: "required",
    nightSensitivity: 5,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 5,
    heatSensitivity: 5,
    coldSensitivity: 5,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 4,
    visibilitySensitivity: 3
  },
  photography: {
    label: "Photography / filming",
    shortDescription: "Prefers daylight and reacts quickly to fog, smoke, wind, and reduced visibility.",
    minPreferredWindowHours: 2,
    daylightPreference: "required",
    nightSensitivity: 4,
    precipitationSensitivity: 4,
    thunderstormSensitivity: 4,
    heatSensitivity: 2,
    coldSensitivity: 3,
    windSensitivity: 4,
    gustSensitivity: 4,
    aqiSensitivity: 3,
    visibilitySensitivity: 5
  }
};

export function getActivityConfig(activity: ActivityMode) {
  return activityConfigs[activity];
}

export function getActivityOptions() {
  return Object.entries(activityConfigs).map(([value, config]) => ({
    value: value as ActivityMode,
    label: config.label,
    description: config.shortDescription
  }));
}

export function isLateNightHour(hourIso: string, timeZone: string) {
  const hour = getZonedHour(hourIso, timeZone);
  return hour >= 0 && hour < 5;
}

export function isLateNightWindow(
  startIso: string,
  endIso: string,
  timeZone: string
) {
  const startHour = getZonedHour(startIso, timeZone);
  const endHour = getZonedHour(endIso, timeZone);
  return startHour >= 0 && startHour < 5 && (endHour <= 5 || endHour === 0);
}
