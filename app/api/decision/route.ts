import { NextRequest, NextResponse } from "next/server";
import { fetchAirQuality } from "@/lib/airnow";
import { activityConfigs } from "@/lib/activityConfig";
import { buildSummary } from "@/lib/decisionSummary";
import {
  buildEventSummary,
  getEventTimelineHours,
  scorePlannedEvent
} from "@/lib/eventPlanning";
import { filterForecastHoursForHorizon } from "@/lib/horizon";
import { resolveLocationQuery } from "@/lib/locationLookup";
import { fetchNwsAlerts, fetchNwsForecast } from "@/lib/nws";
import {
  fetchOpenMeteoAirQuality,
  matchAirQualityToForecastHours
} from "@/lib/openMeteoAirQuality";
import { scoreForecastHours } from "@/lib/scoring";
import {
  selectBestWindows,
  mergeHoursIntoWindows
} from "@/lib/timeWindows";
import {
  ActivityMode,
  DecisionRequestBody,
  DecisionResponse,
  PlanningMode,
  TimeHorizon
} from "@/lib/types";
import { getZonedHour, isValidUsLocationQuery } from "@/lib/utils";

export const dynamic = "force-dynamic";
const validActivities = new Set(Object.keys(activityConfigs));

function normalizeRequestBody(body: Partial<DecisionRequestBody>) {
  const locationQuery = String(body.locationQuery ?? body.zipCode ?? "").trim();
  const activity = body.activity as ActivityMode;
  const horizon = body.horizon as TimeHorizon;
  const planningMode = (body.planningMode as PlanningMode | undefined) ?? "flexible";
  const eventStartDate = String(body.eventStartDate ?? body.eventDate ?? "").trim();
  const eventEndDate = String(body.eventEndDate ?? body.eventDate ?? "").trim();
  const eventStartTime = String(body.eventStartTime ?? "").trim();
  const eventEndTime = String(body.eventEndTime ?? "").trim();
  const suggestAlternates = body.suggestAlternates ?? true;

  if (!isValidUsLocationQuery(locationQuery)) {
    throw new Error("Please enter a U.S. ZIP code or City, ST.");
  }

  if (!validActivities.has(activity)) {
    throw new Error("Please choose an activity mode.");
  }

  if (!["today", "tonight", "24h", "48h"].includes(horizon)) {
    throw new Error("Please choose a time horizon.");
  }

  if (!["flexible", "event"].includes(planningMode)) {
    throw new Error("Please choose a planning mode.");
  }

  if (planningMode === "event") {
    if (!eventStartDate || !eventEndDate || !eventStartTime || !eventEndTime) {
      throw new Error("Please enter a start date, start time, end date, and end time.");
    }
  }

  return {
    locationQuery,
    activity,
    horizon,
    planningMode,
    eventStartDate,
    eventEndDate,
    eventStartTime,
    eventEndTime,
    suggestAlternates: Boolean(suggestAlternates)
  };
}

function formatLocationLabel(location: Awaited<ReturnType<typeof resolveLocationQuery>>) {
  const cityState = [location.city, location.state].filter(Boolean).join(", ");
  if (location.postalCode && cityState) {
    return `${location.postalCode} - ${cityState}`;
  }
  if (cityState) {
    return cityState;
  }
  if (location.postalCode) {
    return `ZIP ${location.postalCode}`;
  }
  return location.inputLabel ?? "Forecast location";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<DecisionRequestBody>;
    const {
      locationQuery,
      activity,
      horizon,
      planningMode,
      eventStartDate,
      eventEndDate,
      eventStartTime,
      eventEndTime,
      suggestAlternates
    } = normalizeRequestBody(body);
    const coordinates = await resolveLocationQuery(locationQuery);

    const [forecastResult, alertsResult] = await Promise.all([
      fetchNwsForecast(coordinates.latitude, coordinates.longitude),
      fetchNwsAlerts(coordinates.latitude, coordinates.longitude)
    ]);
    const { hours: forecastHours, timeZone } = forecastResult;
    const alerts = alertsResult.alerts;
    const openMeteoAirQuality = await fetchOpenMeteoAirQuality(
      coordinates.latitude,
      coordinates.longitude,
      timeZone
    );
    const fallbackAirQuality =
      openMeteoAirQuality.available || !process.env.AIRNOW_API_KEY
        ? null
        : await fetchAirQuality(coordinates.latitude, coordinates.longitude);
    const airQuality = openMeteoAirQuality.available
      ? openMeteoAirQuality
      : fallbackAirQuality ?? {
          primary: null,
          available: false,
          note: "AQI is unavailable right now, but weather guidance still works.",
          hourlyReadings: []
        };
    const airQualityByHour = openMeteoAirQuality.available
      ? matchAirQualityToForecastHours(
          forecastHours,
          openMeteoAirQuality.hourlyReadings,
          timeZone
        )
      : undefined;
    const allScoredHours = scoreForecastHours({
      hours: forecastHours,
      alerts,
      airQuality: airQuality.primary,
      airQualityByHour,
      activity,
      timeZone
    });

    if (planningMode === "event") {
      const eventResult = scorePlannedEvent({
        scoredHours: allScoredHours,
        eventStartDate,
        eventEndDate,
        eventStartTime,
        eventEndTime,
        timeZone,
        activity,
        suggestAlternates,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        now: new Date()
      });
      const timelineHours = getEventTimelineHours({
        scoredHours: allScoredHours,
        eventStartTime: eventResult.startTime,
        eventEndTime: eventResult.endTime,
        alternateWindow: eventResult.bestAlternateWindow
      });
      const response: DecisionResponse = {
        location: {
          postalCode: coordinates.postalCode,
          label: formatLocationLabel(coordinates),
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          timeZone
        },
        planningMode,
        activity,
        horizon,
        summary: buildEventSummary({
          eventResult,
          timeZone,
          hourly: allScoredHours,
          alerts
        }),
        bestWindow: null,
        secondaryWindow: null,
        nextAvailableWindow: null,
        eventResult,
        cautionWindows: [],
        avoidWindows: [],
        hourly: timelineHours,
        alerts,
        alertsInfo: {
          available: alertsResult.available,
          note: alertsResult.note
        },
        airQuality,
        generatedAt: new Date().toISOString()
      };

      return NextResponse.json(response);
    }

    const filteredHours = filterForecastHoursForHorizon(forecastHours, horizon, timeZone);
    let nextAvailableWindow = null;
    let hourly =
      filteredHours.length > 0
        ? scoreForecastHours({
            hours: filteredHours,
            alerts,
            airQuality: airQuality.primary,
            airQualityByHour,
            activity,
            timeZone
          })
        : [];
    const todayNearlyOver =
      horizon === "today" &&
      (getZonedHour(new Date(), timeZone) >= 20 || filteredHours.length < 2);

    let windows = mergeHoursIntoWindows(hourly);
    let selected = selectBestWindows(windows, hourly, horizon, timeZone, activity, {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude
    });

    if (horizon === "today" && !selected.bestWindow) {
      const tonightHours = filterForecastHoursForHorizon(
        forecastHours,
        "tonight",
        timeZone
      );

      if (tonightHours.length) {
        const tonightScored = scoreForecastHours({
          hours: tonightHours,
          alerts,
          airQuality: airQuality.primary,
          airQualityByHour,
          activity,
          timeZone
        });
        nextAvailableWindow =
          selectBestWindows(
            mergeHoursIntoWindows(tonightScored),
            tonightScored,
            "tonight",
            timeZone,
            activity,
            {
              latitude: coordinates.latitude,
              longitude: coordinates.longitude
            }
          )
            .bestWindow ?? null;
      }
    } else if (horizon === "tonight" && !selected.bestWindow) {
      const tonightHours = filterForecastHoursForHorizon(
        forecastHours,
        "tonight",
        timeZone
      );
      const tonightCutoff =
        tonightHours.length > 0
          ? new Date(tonightHours[tonightHours.length - 1].endTime).getTime()
          : Date.now();
      const nextDayHours = forecastHours.filter(
        (hour) => new Date(hour.startTime).getTime() >= tonightCutoff
      );

      if (nextDayHours.length) {
        const nextDayScored = scoreForecastHours({
          hours: nextDayHours.slice(0, 12),
          alerts,
          airQuality: airQuality.primary,
          airQualityByHour,
          activity,
          timeZone
        });
        nextAvailableWindow =
          selectBestWindows(
            mergeHoursIntoWindows(nextDayScored),
            nextDayScored,
            "24h",
            timeZone,
            activity,
            {
              latitude: coordinates.latitude,
              longitude: coordinates.longitude
            }
          ).bestWindow ??
          null;
      }
    }

    if (!filteredHours.length && !nextAvailableWindow && !forecastHours.length) {
      throw new Error("No forecast hours are available for that timeframe yet.");
    }

    const response: DecisionResponse = {
      location: {
        postalCode: coordinates.postalCode,
        label: formatLocationLabel(coordinates),
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        timeZone
      },
      planningMode,
      activity,
      horizon,
      summary: buildSummary({
        bestWindow: selected.bestWindow,
        alerts,
        airQuality,
        hourly,
        nextAvailableWindow
      }, horizon, timeZone, activity, {
        todayNearlyOver,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude
      }),
      bestWindow: selected.bestWindow,
      secondaryWindow: selected.secondaryWindow,
      nextAvailableWindow,
      eventResult: null,
      cautionWindows: selected.cautionWindows,
      avoidWindows: selected.avoidWindows,
      hourly,
      alerts,
      alertsInfo: {
        available: alertsResult.available,
        note: alertsResult.note
      },
      airQuality,
      generatedAt: new Date().toISOString()
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Something went wrong while analyzing conditions.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
