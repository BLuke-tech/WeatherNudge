# WeatherNudge

WeatherNudge is a real outdoor-planning decision tool built with Next.js App Router. Enter a U.S. ZIP code or `City, ST`, choose an activity, and either find the best outdoor window or score a planned event using live National Weather Service data plus Open-Meteo AQI.

## What it does

- Accepts a U.S. ZIP code or `City, ST` for a simple U.S.-only location flow
- Supports two planning modes:
  - flexible mode: find the best outdoor window
  - planned event mode: score a specific event time and suggest a better same-duration alternate when helpful
- Pulls live hourly forecast data and alerts from the National Weather Service
- Pulls hourly Open-Meteo AQI server-side by default with no API key required
- Can fall back to AirNow if an `AIRNOW_API_KEY` is configured and Open-Meteo is unavailable
- Uses the forecast location time zone for horizon logic, labels, and event matching
- Uses real sunrise and sunset timing with SunCalc for daylight-aware recommendations
- Scores hourly periods with a transparent, editable rule engine
- Detects forecast hazards from hourly forecast text, including:
  - thunderstorms and severe storms
  - tornado risk
  - flooding and heavy rain
  - snow, wintry mix, and freezing rain
  - fog, smoke, visibility issues, and extreme heat or cold
- Returns:
  - recommended or best-available window
  - caution and avoid periods
  - plain-English reasons
  - alert and AQI context
  - event-specific scoring details in planned event mode
  - better alternate windows when available

## Stack

- Next.js 14 App Router
- TypeScript
- React
- Tailwind CSS
- Route handlers for server-side API orchestration
- SunCalc for daylight-aware sunrise and sunset logic

## Project structure

```text
app/
  api/decision/route.ts
  globals.css
  layout.tsx
  page.tsx
components/
  ActivitySelector.tsx
  AirQualityPanel.tsx
  AlertsPanel.tsx
  EventTimeFields.tsx
  ErrorState.tsx
  HourlyTimeline.tsx
  LoadingState.tsx
  PlanningModeSelector.tsx
  RecommendationCard.tsx
  TimeHorizonSelector.tsx
  WhyPanel.tsx
  ZipInputForm.tsx
lib/
  activityConfig.ts
  airnow.ts
  daylight.ts
  decisionSummary.ts
  eventPlanning.ts
  forecastHazards.ts
  horizon.ts
  locationLookup.ts
  nws.ts
  openMeteoAirQuality.ts
  scoring.ts
  timeWindows.ts
  types.ts
  utils.ts
  zipToLatLon.ts
tests/
  weatherLogic.test.ts
```

## Planning modes

### Flexible mode

Use this when the user wants the app to answer:

- When is the best time to go outside?
- Which hours should I avoid?
- Are conditions better later?

The app searches the selected forecast horizon and picks a compact, practical window rather than an all-day span.

### Planned event mode

Use this when the user already has a time in mind.

Inputs:

- start date
- start time
- end date
- end time
- activity
- location

The app scores the full event duration, highlights the worst overlapping period when relevant, and can suggest a better same-duration alternate if conditions are poor.

## Activity modes

Supported activities:

- General exercise
- Outdoor hangout
- Study outside
- Walking / dog walk
- Running
- Biking
- Hiking
- Fishing
- Outdoor dining
- Kids sports
- Yard work
- Outdoor work
- Photography / filming

Each activity has a small config that controls:

- preferred window length
- daylight behavior
- sensitivity to precipitation
- sensitivity to thunderstorms
- heat and cold sensitivity
- wind and gust sensitivity
- AQI sensitivity
- visibility sensitivity

Daylight behavior tiers:

- `required`: hiking, biking, kids sports, yard work, outdoor work, photography / filming
- `preferred`: walking, running, outdoor dining, study outside, general exercise
- `night-allowed`: fishing, outdoor hangout

For daylight-required activities, flexible recommendations prefer real daylight windows and will avoid nighttime recommendations when a viable daylight option exists.

## Environment variables

Copy `.env.example` to `.env.local` and fill in the values you need:

```bash
cp .env.example .env.local
```

Optional:

- `AIRNOW_API_KEY`
  - Legacy fallback only. Open-Meteo Air Quality is used by default without a key.

- `NWS_USER_AGENT`
  - Recommended for production so requests to `api.weather.gov` identify your app and contact.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Start the dev server:

```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000)

## Troubleshooting

If the dev server shows an unstyled or stale page, or returns `404` errors for `/_next/static` chunk or CSS files on Windows, stop the server and run:

```bash
npm run dev:clean
```

For production build testing, use:

```bash
npm run build:clean
```

These commands clear stale `.next` and `node_modules/.cache` artifacts and are useful after larger code changes or interrupted dev-server restarts.

## Vercel deployment

This app uses standard Next.js App Router conventions and does not require a special Vercel plugin.

1. Push the project to a Git provider supported by Vercel.
2. Import the repository into Vercel.
3. In Vercel project settings, add:
   - `AIRNOW_API_KEY`
   - `NWS_USER_AGENT` (recommended)
4. Deploy.

Because all external API calls happen in `app/api/decision/route.ts`, secrets stay server-side and are never exposed to the client.

## Architecture summary

### Request flow

1. The client sends a location query, activity mode, planning mode, and either a horizon or event timing to `/api/decision`.
2. The server route:
   - resolves ZIP codes with Zippopotam.us
   - resolves `City, ST` queries with Open-Meteo geocoding
   - fetches hourly forecast and alerts from NWS
   - fetches hourly AQI from Open-Meteo by default
   - optionally falls back to AirNow when configured
3. The server derives the forecast location time zone from NWS and keeps time logic server-side.
4. The server normalizes data into internal types.
5. The scoring engine evaluates each hour from `0-100`.
6. Flexible mode selects compact recommendation windows.
7. Event mode scores the exact event duration and finds better same-duration alternates when requested.
8. The route returns structured data for the UI.

### Scoring model

Each hour is scored from:

- apparent temperature / comfort
- precipitation chance
- wind and gusts
- humidity / dew point
- visibility
- active alerts
- AQI
- forecast hazard text

Hazards can override the numeric score. Examples include:

- tornado risk
- severe thunderstorms
- flash flooding
- freezing rain / ice
- heavy snow
- dangerous heat or cold
- warning-level alerts

Score guide:

- `Good`: `80-100`
- `Caution`: `40-79`
- `Avoid`: `0-39`

### Daylight and time handling

- Horizon filtering uses the forecast location time zone, not the browser or computer time zone.
- Displayed hours and recommended windows also use the forecast location time zone.
- Daylight-aware recommendations use SunCalc with latitude, longitude, date, and time zone.
- If exact daylight calculation cannot be used, the app falls back safely to NWS `isDaytime`, then to a simple local-hour approximation.

### Event scoring

Planned events are scored across the full duration, not just one hour.

Examples:

- any severe warning overlapping the event forces `Avoid`
- a short event with one `Avoid` hour becomes `Avoid`
- a longer event with mixed `Good` and `Caution` hours may settle at `Caution`
- if alternates are enabled, the app looks for a better window with the same duration

### Fallback behavior

- If Open-Meteo AQI is unavailable, the app still returns weather-only guidance.
- If AirNow is configured, it can serve as a legacy fallback AQI source.
- If alerts cannot be fetched, the app continues and notes that limitation.
- If hourly weather forecast fetch fails, the route returns a friendly error state.
- If a forecast field like gusts, visibility, or dew point is missing, scoring stays neutral and the app does not crash.

## Notes

- v1 is U.S.-only by design.
- The app is stateless and does not rely on local file persistence, databases, auth, or background jobs.
- Rule logic is intentionally simple and editable in [lib/scoring.ts](/C:/Users/bzmami/Desktop/Weather%20Decision%20Dashboard/lib/scoring.ts).
- Daylight selection logic is implemented in [lib/daylight.ts](/C:/Users/bzmami/Desktop/Weather%20Decision%20Dashboard/lib/daylight.ts).
- Planned event logic lives in [lib/eventPlanning.ts](/C:/Users/bzmami/Desktop/Weather%20Decision%20Dashboard/lib/eventPlanning.ts).
- Future possible factor:
  pollen/allergy risk and dust can be added later as optional informational context, but they are not active core scoring inputs in the current MVP.
