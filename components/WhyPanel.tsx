import React from "react";
import { DecisionResponse } from "@/lib/types";

interface WhyPanelProps {
  result: DecisionResponse;
}

export function WhyPanel({ result }: WhyPanelProps) {
  const sourceReasons =
    result.planningMode === "event" && result.eventResult
      ? result.eventResult.reasons
      : result.bestWindow?.reasons ?? result.hourly.flatMap((hour) => hour.reasons);
  const supplementalReasons = (() => {
    if (!result.summary.highlightInsight) return [];
    const insight = result.summary.highlightInsight.toLowerCase();

    if (insight.includes("air quality worsens later") || insight.includes("aqi reaches")) {
      return ["AQI stays lower during this window"];
    }

    return [];
  })();

  const mainFactorLower = result.summary.mainFactor.toLowerCase();
  const uniqueReasons = Array.from(new Set([...sourceReasons, ...supplementalReasons]));
  if (
    result.summary.messageType === "time_limited" ||
    result.summary.messageType === "daylight_limited"
  ) {
    return (
      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-panel">
        <h2 className="text-xl font-semibold text-ink">
          {result.planningMode === "event" ? "Why this event was scored this way" : "Why this was chosen"}
        </h2>
        <p className="mt-4 rounded-2xl bg-mist px-4 py-3 text-sm font-semibold text-ink">
          Main factor: {result.summary.mainFactor}
        </p>
      </section>
    );
  }
  const getReasonCategory = (text: string) => {
    const value = text.toLowerCase();
    if (value.includes("daylight")) return "daylight";
    if (value.includes("warning") || value.includes("watch") || value.includes("alert")) return "alert";
    if (value.includes("thunderstorm") || value.includes("severe storm") || value.includes("tornado")) return "storm";
    if (value.includes("flood")) return "flood";
    if (value.includes("snow") || value.includes("ice")) return "winter";
    if (value.includes("visibility") || value.includes("fog") || value.includes("smoke")) return "visibility";
    if (value.includes("wind")) return "wind";
    if (value.includes("heat") || value.includes("cold") || value.includes("feels like")) return "temperature";
    if (value.includes("precip")) return "precip";
    if (value.includes("air quality") || value.includes("aqi")) return "aqi";
    if (value.includes("comfortable around") || value.includes("comfortable conditions")) return "comfort";
    return "other";
  };
  const mainFactorCategory = getReasonCategory(mainFactorLower);
  const hasHazards = uniqueReasons.some(
    (reason) =>
      reason.includes("warning") ||
      reason.includes("watch") ||
      reason.includes("storm") ||
      reason.includes("flood") ||
      reason.includes("snow") ||
      reason.includes("ice") ||
      reason.includes("visibility") ||
      reason.includes("wind") ||
      reason.includes("heat") ||
      reason.includes("cold")
  );
  const filteredReasons = uniqueReasons.filter((reason) => {
    const reasonLower = reason.toLowerCase();
    const reasonCategory = getReasonCategory(reasonLower);

    if (reason === "high precip chance" && uniqueReasons.includes("very high precip chance")) {
      return false;
    }
    if (
      reason === "low precip risk" &&
      (mainFactorLower.includes("low precipitation risk") || mainFactorCategory === "precip")
    ) {
      return false;
    }
    if (hasHazards && reason.startsWith("comfortable around")) {
      return false;
    }
    if (mainFactorCategory === "precip" && reason === "snow may affect conditions") {
      return false;
    }
    if (mainFactorCategory === "storm" && reason === "thunderstorms possible") {
      return false;
    }
    if (mainFactorCategory === "wind" && reasonLower.includes("wind")) {
      return false;
    }
    if (mainFactorCategory === "comfort" && reasonLower.startsWith("comfortable around")) {
      return false;
    }
    if (mainFactorCategory === "visibility" && reasonCategory === "visibility") {
      return false;
    }
    if (mainFactorCategory === "aqi" && reasonCategory === "aqi") {
      return false;
    }
    if (
      mainFactorCategory === "aqi" &&
      (reasonLower.startsWith("feels like ") || reasonLower.startsWith("comfortable around"))
    ) {
      return false;
    }
    if (
      reasonLower.startsWith("feels like ") &&
      uniqueReasons.some(
        (otherReason) =>
          otherReason !== reason &&
          otherReason.toLowerCase().startsWith("feels like ")
      )
    ) {
      return false;
    }
    if (mainFactorCategory === "daylight" && reasonCategory === "daylight") {
      return false;
    }
    return true;
  });
  const priority = (reason: string) => {
    if (reason.includes("warning") || reason.includes("watch") || reason === "active severe weather alert") {
      return 0;
    }
    if (
      reason.includes("storm") ||
      reason.includes("snow") ||
      reason.includes("flood") ||
      reason.includes("ice") ||
      reason.includes("visibility") ||
      reason.includes("heat") ||
      reason.includes("cold")
    ) {
      return 1;
    }
    if (reason.includes("air quality") || reason.includes("aqi")) {
      return 2;
    }
    if (reason.includes("precip") || reason.includes("% ")) {
      return 3;
    }
    return 4;
  };
  const reasons = filteredReasons.sort((a, b) => priority(a) - priority(b)).slice(0, 3);

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-panel">
      <h2 className="text-xl font-semibold text-ink">
        {result.planningMode === "event" ? "Why this event was scored this way" : "Why this was chosen"}
      </h2>
      <p className="mt-4 rounded-2xl bg-mist px-4 py-3 text-sm font-semibold text-ink">
        Main factor: {result.summary.mainFactor}
      </p>
      <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
        {reasons.map((reason) => (
          <li key={reason} className="flex gap-3">
            <span className="mt-2 h-2 w-2 rounded-full bg-tide" />
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
