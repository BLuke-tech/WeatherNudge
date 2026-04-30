import React from "react";
import { WeatherAlert } from "@/lib/types";

interface AlertsPanelProps {
  alerts: WeatherAlert[];
  note?: string;
  available: boolean;
}

export function AlertsPanel({ alerts, note, available }: AlertsPanelProps) {
  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink">Active alerts (current conditions)</h2>
        </div>
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-xs font-semibold text-slate-500 shadow-sm"
          title="Shows currently active warnings from the National Weather Service."
          aria-label="Shows currently active warnings from the National Weather Service."
        >
          i
        </span>
      </div>
      {!available && note ? (
        <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm leading-7 text-slate-700">
          {note}
        </div>
      ) : null}
      {alerts.length ? (
        <div className="mt-4 space-y-4">
          {alerts.map((alert) => (
            <article
              key={alert.id}
              className="rounded-2xl border border-coral/20 bg-rose-50 p-4"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-coral px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
                  {alert.severity}
                </span>
                <h3 className="text-sm font-semibold text-ink">{alert.event}</h3>
              </div>
              <p className="mt-3 text-sm leading-7 text-slate-700">{alert.headline}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm leading-7 text-slate-600">
          {available
            ? "No active weather alerts were returned for this location."
            : "No alert details were returned for this location."}
        </p>
      )}
    </section>
  );
}
