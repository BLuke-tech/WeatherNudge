"use client";

import { ActivityMode } from "@/lib/types";
import { getActivityConfig, getActivityOptions } from "@/lib/activityConfig";

interface ActivitySelectorProps {
  value: ActivityMode;
  onChange: (value: ActivityMode) => void;
}

export function ActivitySelector({ value, onChange }: ActivitySelectorProps) {
  const selected = getActivityConfig(value);
  const options = getActivityOptions();

  return (
    <div className="space-y-3">
      <label htmlFor="activity-mode" className="text-sm font-medium text-slate-700">
        Activity mode
      </label>
      <select
        id="activity-mode"
        value={value}
        onChange={(event) => onChange(event.target.value as ActivityMode)}
        className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 outline-none transition focus:border-tide focus:ring-2 focus:ring-sky/40"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="rounded-2xl bg-mist px-4 py-3 text-sm leading-6 text-slate-600">
        {selected.shortDescription}
      </p>
    </div>
  );
}
