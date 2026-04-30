"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ActivitySelector } from "@/components/ActivitySelector";
import { AirQualityPanel } from "@/components/AirQualityPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { EventTimeFields } from "@/components/EventTimeFields";
import { ErrorState } from "@/components/ErrorState";
import { HourlyTimeline } from "@/components/HourlyTimeline";
import { LoadingState } from "@/components/LoadingState";
import { PlanningModeSelector } from "@/components/PlanningModeSelector";
import { RecommendationCard } from "@/components/RecommendationCard";
import { TimeHorizonSelector } from "@/components/TimeHorizonSelector";
import { WhyPanel } from "@/components/WhyPanel";
import { ZipInputForm } from "@/components/ZipInputForm";
import {
  ActivityMode,
  DecisionResponse,
  PlanningMode,
  TimeHorizon
} from "@/lib/types";
import { shouldRevealResults } from "@/lib/resultsFocus";
import { isValidUsLocationQuery } from "@/lib/utils";

export default function HomePage() {
  const [locationQuery, setLocationQuery] = useState("");
  const [activity, setActivity] = useState<ActivityMode>("exercise");
  const [horizon, setHorizon] = useState<TimeHorizon>("today");
  const [planningMode, setPlanningMode] = useState<PlanningMode>("flexible");
  const [eventStartDate, setEventStartDate] = useState("");
  const [eventEndDate, setEventEndDate] = useState("");
  const [eventStartTime, setEventStartTime] = useState("");
  const [eventEndTime, setEventEndTime] = useState("");
  const [endDateManuallyChanged, setEndDateManuallyChanged] = useState(false);
  const [suggestAlternates, setSuggestAlternates] = useState(true);
  const [result, setResult] = useState<DecisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [completedRunId, setCompletedRunId] = useState<number | null>(null);
  const [revealedRunId, setRevealedRunId] = useState<number | null>(null);
  const [highlightResults, setHighlightResults] = useState(false);
  const [showResultsReady, setShowResultsReady] = useState(false);
  const analysisRunRef = useRef(0);
  const resultsRef = useRef<HTMLElement | null>(null);
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyTextTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (planningMode !== "event") return;
    if (!eventStartDate) return;

    if (!endDateManuallyChanged) {
      setEventEndDate((currentValue) => currentValue || eventStartDate);
    }
  }, [endDateManuallyChanged, eventStartDate, planningMode]);

  useEffect(() => {
    if (planningMode !== "event") return;
    if (!eventStartDate || !eventStartTime || !eventEndTime || endDateManuallyChanged) return;

    if (eventEndDate && eventEndDate !== eventStartDate) return;

    const [startHour, startMinute] = eventStartTime.split(":").map(Number);
    const [endHour, endMinute] = eventEndTime.split(":").map(Number);
    if (
      Number.isNaN(startHour) ||
      Number.isNaN(startMinute) ||
      Number.isNaN(endHour) ||
      Number.isNaN(endMinute)
    ) {
      return;
    }

    const startValue = startHour * 60 + startMinute;
    const endValue = endHour * 60 + endMinute;

    if (endValue < startValue) {
      const nextDay = new Date(`${eventStartDate}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      setEventEndDate(nextDay.toISOString().slice(0, 10));
      return;
    }

    setEventEndDate(eventStartDate);
  }, [
    endDateManuallyChanged,
    eventEndDate,
    eventEndTime,
    eventStartDate,
    eventStartTime,
    planningMode
  ]);

  const eventHelperText = useMemo(() => {
    if (planningMode !== "event") return "";
    if (!eventStartDate || !eventStartTime || !eventEndDate || !eventEndTime) {
      return "Events can cross midnight. Use the end date to show overnight plans clearly.";
    }

    const start = new Date(`${eventStartDate}T${eventStartTime}`);
    const end = new Date(`${eventEndDate}T${eventEndTime}`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return "Events can cross midnight. Use the end date to show overnight plans clearly.";
    }

    if (end <= start) {
      return "Please make sure the event end date and time are after the start.";
    }

    return "Events can cross midnight. Use the end date to show overnight plans clearly.";
  }, [eventEndDate, eventEndTime, eventStartDate, eventStartTime, planningMode]);

  useEffect(() => {
    if (
      !shouldRevealResults({
        isLoading,
        hasResult: Boolean(result),
        completedRunId,
        revealedRunId
      })
    ) {
      return;
    }

    if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    if (readyTextTimeoutRef.current) clearTimeout(readyTextTimeoutRef.current);

    revealTimeoutRef.current = setTimeout(() => {
      resultsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
      setHighlightResults(true);
      setShowResultsReady(true);
      setRevealedRunId(completedRunId);

      highlightTimeoutRef.current = setTimeout(() => setHighlightResults(false), 1200);
      readyTextTimeoutRef.current = setTimeout(() => setShowResultsReady(false), 1200);
    }, 150);

    return () => {
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      if (readyTextTimeoutRef.current) clearTimeout(readyTextTimeoutRef.current);
    };
  }, [completedRunId, isLoading, result, revealedRunId]);

  const handleAnalyze = async () => {
    if (!isValidUsLocationQuery(locationQuery)) {
      setError("Please enter a U.S. ZIP code or City, ST.");
      return;
    }

    if (
      planningMode === "event" &&
      (!eventStartDate || !eventEndDate || !eventStartTime || !eventEndTime)
    ) {
      setError("Please enter a start date, start time, end date, and end time.");
      return;
    }

    if (
      planningMode === "event" &&
      new Date(`${eventEndDate}T${eventEndTime}`) <= new Date(`${eventStartDate}T${eventStartTime}`)
    ) {
      setError("Please make sure the event end date and time are after the start.");
      return;
    }

    setError(null);
    setIsLoading(true);
    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;

    try {
      const response = await fetch("/api/decision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          locationQuery,
          activity,
          horizon,
          planningMode,
          eventStartDate,
          eventEndDate,
          eventStartTime,
          eventEndTime,
          suggestAlternates
        })
      });

      const payload = (await response.json()) as DecisionResponse | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Unable to analyze current conditions."
        );
      }

      setResult(payload as DecisionResponse);
      setCompletedRunId(runId);
    } catch (requestError) {
      setResult(null);
      setCompletedRunId(null);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to analyze current conditions."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen">
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
        <div className="rounded-[2rem] border border-white/60 bg-hero-glow bg-white/70 p-6 shadow-panel backdrop-blur sm:p-8 lg:p-10">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-tide">
              <span className="uppercase tracking-[0.24em]">WeatherNudge</span>
              <span className="text-[11px] font-medium tracking-[0.08em] text-slate-500">
                · Smart outdoor planning
              </span>
            </span>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
              Weather says 40% chance of rain. Should you go?
              <span
                className="ml-3 inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white align-middle text-xs font-semibold text-slate-500 shadow-sm sm:h-7 sm:w-7 sm:text-sm"
                title="Provides planning guidance using forecast data. Always follow official warnings."
                aria-label="Provides planning guidance using forecast data. Always follow official warnings."
              >
                i
              </span>
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-8 text-slate-700 sm:text-lg">
              WeatherNudge reads the forecast so you don&apos;t have to — and gives you a clear go, wait, or avoid for your specific outdoor activity.
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
              Tell it what you&apos;re doing. Get a clear answer.
            </p>
          </div>

          <div className="mt-10 grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-6 rounded-[2rem] border border-white/60 bg-white/85 p-6">
              <ZipInputForm value={locationQuery} onChange={setLocationQuery} />
              <ActivitySelector value={activity} onChange={setActivity} />
              <PlanningModeSelector
                value={planningMode}
                onChange={setPlanningMode}
              />
              {planningMode === "flexible" ? (
                <TimeHorizonSelector value={horizon} onChange={setHorizon} />
              ) : (
                <EventTimeFields
                  eventStartDate={eventStartDate}
                  eventEndDate={eventEndDate}
                  eventStartTime={eventStartTime}
                  eventEndTime={eventEndTime}
                  suggestAlternates={suggestAlternates}
                  helperText={eventHelperText}
                  onEventStartDateChange={(value) => {
                    setEventStartDate(value);
                    if (!endDateManuallyChanged) {
                      setEventEndDate(value);
                    }
                  }}
                  onEventEndDateChange={(value) => {
                    setEndDateManuallyChanged(true);
                    setEventEndDate(value);
                  }}
                  onEventStartTimeChange={setEventStartTime}
                  onEventEndTimeChange={setEventEndTime}
                  onSuggestAlternatesChange={setSuggestAlternates}
                />
              )}
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={isLoading}
                className="inline-flex h-12 items-center justify-center rounded-full bg-ink px-6 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isLoading ? "Analyzing..." : "Analyze conditions"}
              </button>
            </div>

            <div className="rounded-[2rem] border border-white/60 bg-white/80 p-6">
              <h2 className="text-xl font-semibold text-ink">What you&apos;ll get</h2>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <ValueCard
                  title="Recommended window"
                  body="A practical time stretch with the best balance of comfort, precipitation risk, alerts, and air quality."
                />
                <ValueCard
                  title="Planned event score"
                  body="A direct read on your chosen event time, with a better alternate if the forecast looks rough."
                />
                <ValueCard
                  title="Use caution"
                  body="Hours that may still work if your plans are flexible and you know the tradeoffs."
                />
                <ValueCard
                  title="Why this was chosen"
                  body="Plain-English reasons so the recommendation feels transparent and practical."
                />
              </div>
            </div>
          </div>
        </div>

        <section
          id="results-section"
          ref={resultsRef}
          className={`mt-10 space-y-6 scroll-mt-4 sm:scroll-mt-6 ${
            highlightResults ? "results-highlight" : ""
          }`}
        >
          {showResultsReady ? (
            <p className="results-ready-badge text-sm font-medium text-emerald-700">
              Results ready
            </p>
          ) : null}
          {isLoading ? <LoadingState /> : null}
          {!isLoading && error ? <ErrorState message={error} /> : null}

          {!isLoading && !error && result ? (
            <div className="space-y-6">
              <RecommendationCard
                key={`recommendation-${completedRunId ?? result.generatedAt}`}
                result={result}
              />
              <HourlyTimeline
                hours={result.hourly}
                timeZone={result.location.timeZone}
                highlightAqi={/aqi|air quality/i.test(
                  [
                    result.eventResult?.mainConcern,
                    result.summary.mainFactor,
                    result.summary.highlightInsight
                  ]
                    .filter(Boolean)
                    .join(" ")
                )}
                plannedWindow={
                  result.eventResult
                    ? {
                        startTime: result.eventResult.startTime,
                        endTime: result.eventResult.endTime,
                        label: "Planned event"
                      }
                    : undefined
                }
                alternateWindow={
                  result.eventResult?.bestAlternateWindow
                    ? {
                        startTime: result.eventResult.bestAlternateWindow.startTime,
                        endTime: result.eventResult.bestAlternateWindow.endTime,
                        label: "Suggested alternate"
                      }
                    : undefined
                }
              />
              <div className="grid gap-6 lg:grid-cols-3">
                <WhyPanel result={result} />
                <AlertsPanel
                  alerts={result.alerts}
                  available={result.alertsInfo.available}
                  note={result.alertsInfo.note}
                />
                <AirQualityPanel result={result} />
              </div>
            </div>
          ) : null}

          {!isLoading && !error && !result ? (
            <section className="rounded-[2rem] border border-dashed border-slate-300 bg-white/80 p-8 text-center shadow-panel">
              <h2 className="text-xl font-semibold text-ink">Ready when you are</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-600">
                Enter a U.S. ZIP code or City, ST, then either find the best outdoor window or score a specific planned event using live National Weather Service data plus Open-Meteo air quality.
              </p>
            </section>
          ) : null}
        </section>

        <footer className="mt-8 px-2 pb-2 text-center text-sm leading-6 text-slate-500">
          Planning guidance only. This app does not replace official weather alerts or emergency instructions.
        </footer>
      </section>
    </main>
  );
}

function ValueCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-3xl bg-mist p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-7 text-slate-600">{body}</p>
    </article>
  );
}
