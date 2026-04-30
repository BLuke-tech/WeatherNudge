export type ActivityMode =
  | "exercise"
  | "social"
  | "study"
  | "walking"
  | "running"
  | "biking"
  | "hiking"
  | "fishing"
  | "dining"
  | "kidsSports"
  | "yardWork"
  | "outdoorWork"
  | "photography";
export type TimeHorizon = "today" | "tonight" | "24h" | "48h";
export type PlanningMode = "flexible" | "event";
export type HourClassification = "good" | "caution" | "avoid";
export type RecommendationRating = "Good" | "Caution" | "Avoid";
export type AlertImpactLevel = "none" | "moderate" | "severe";
export type RiskTrend = string;
export type MessageType =
  | "time_limited"
  | "daylight_limited"
  | "alert_blocked"
  | "weather_blocked"
  | "aqi_blocked"
  | "temp_blocked"
  | "fallback"
  | "normal";

export interface Coordinates {
  latitude: number;
  longitude: number;
  city?: string;
  state?: string;
  postalCode?: string | null;
  countryCode?: string;
  inputLabel?: string;
}

export interface ForecastHour {
  startTime: string;
  endTime: string;
  temperatureF: number | null;
  apparentTemperatureF: number | null;
  aqi?: number | null;
  aqiCategory?: string | null;
  temperatureUnit: string;
  windSpeedMph: number | null;
  windGustMph: number | null;
  windDirection: string | null;
  shortForecast: string;
  detailedForecast: string | null;
  precipitationChance: number | null;
  humidity: number | null;
  relativeHumidityPercent: number | null;
  dewpointF: number | null;
  visibilityMiles: number | null;
  fogMentioned: boolean;
  smokeMentioned: boolean;
  isDaytime: boolean;
}

export interface WeatherAlert {
  id: string;
  event: string;
  severity: string;
  headline: string;
  description: string;
  instruction?: string | null;
  onset?: string | null;
  ends?: string | null;
}

export interface AirQualityReading {
  parameter: string;
  aqi: number;
  category: string;
  reportingArea: string;
  stateCode: string;
  dateObserved: string;
  hourObserved?: number | null;
  source?: string;
}

export interface HourlyScoreBreakdown {
  comfort: number;
  precipitation: number;
  wind: number;
  humidity: number;
  visibility: number;
  alerts: number;
  aqi: number;
}

export interface ScoredHour {
  forecast: ForecastHour;
  score: number;
  classification: HourClassification;
  rating: RecommendationRating;
  reasons: string[];
  breakdown: HourlyScoreBreakdown;
  airQuality?: AirQualityReading | null;
  hasAqiImpact?: boolean;
  hasRelevantAlert: boolean;
  alertImpact: AlertImpactLevel;
  activeAlertImpact: AlertImpactLevel;
  recentAlertImpact: Exclude<AlertImpactLevel, "severe"> | "none";
  alertLabel?: string;
  alertContext?: "active-alert" | "recent-alert" | "recent-watch" | null;
}

export interface TimeWindow {
  startTime: string;
  endTime: string;
  classification: HourClassification;
  rating: RecommendationRating;
  averageScore: number;
  reasons: string[];
  hours: ScoredHour[];
  daylightTier?: "daylight" | "mixed-light" | "night";
  selectedAsDaylightFallback?: boolean;
}

export interface EventAnalysis {
  startTime: string;
  endTime: string;
  durationMs: number;
  score: number;
  rating: RecommendationRating;
  classification: HourClassification;
  reasons: string[];
  overlappingHours: ScoredHour[];
  worstWindow: TimeWindow | null;
  bestAlternateWindow: TimeWindow | null;
  bestAlternateReason?: string;
  mainConcern: string;
  confidenceNote?: string;
  guidanceNote?: string;
  daylightNote?: string;
}

export interface DecisionResponse {
  location: {
    postalCode?: string | null;
    label: string;
    latitude: number;
    longitude: number;
    timeZone: string;
  };
  planningMode: PlanningMode;
  activity: ActivityMode;
  horizon: TimeHorizon;
  summary: {
    recommendation: string;
    heading: string;
    confidence: "High" | "Medium" | "Low";
    confidenceExplanation: string;
    explanation: string;
    messageType?: MessageType;
    highlightInsight?: string;
    decisionChip?: string;
    contextNote?: string;
    note?: string;
    banner?: string;
    bannerTone?: "danger" | "warning" | "info";
    emphasis?: "normal" | "caution";
    clearRiskLine?: string;
    riskTrend?: RiskTrend;
    mainFactor: string;
  };
  bestWindow: TimeWindow | null;
  secondaryWindow: TimeWindow | null;
  nextAvailableWindow: TimeWindow | null;
  eventResult?: EventAnalysis | null;
  cautionWindows: TimeWindow[];
  avoidWindows: TimeWindow[];
  hourly: ScoredHour[];
  alerts: WeatherAlert[];
  alertsInfo: {
    available: boolean;
    note?: string;
  };
  airQuality: {
    primary: AirQualityReading | null;
    available: boolean;
    note?: string;
  };
  generatedAt: string;
}

export interface DecisionRequestBody {
  locationQuery?: string;
  zipCode?: string;
  activity: ActivityMode;
  horizon: TimeHorizon;
  planningMode?: PlanningMode;
  eventStartDate?: string;
  eventEndDate?: string;
  eventDate?: string;
  eventStartTime?: string;
  eventEndTime?: string;
  suggestAlternates?: boolean;
}
