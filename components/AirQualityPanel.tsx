import React from "react";
import { DecisionResponse } from "@/lib/types";
import { getAqiMeaning } from "@/lib/utils";

interface AirQualityPanelProps {
  result: DecisionResponse;
}

export function AirQualityPanel({ result }: AirQualityPanelProps) {
  const primary = result.airQuality.primary;

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-panel">
      <h2 className="text-xl font-semibold text-ink">Current air quality</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Forecast values are shown in the hourly timeline.
      </p>
      {primary ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-end gap-3">
            <span className="text-4xl font-semibold text-ink">{primary.aqi}</span>
            <div className="pb-1">
              <p className="text-sm font-semibold text-slate-700">{primary.category}</p>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{primary.parameter}</p>
            </div>
          </div>
          <p className="text-sm leading-7 text-slate-700">{getAqiMeaning(primary.aqi)}</p>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl bg-mist p-4 text-sm leading-7 text-slate-700">
          {result.airQuality.note ??
            "AQI is unavailable right now, but weather guidance still works."}
        </div>
      )}
    </section>
  );
}
