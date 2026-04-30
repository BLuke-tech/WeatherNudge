"use client";

import { PlanningMode } from "@/lib/types";
import { cn } from "@/lib/utils";

const options: Array<{ value: PlanningMode; label: string; description: string }> = [
  {
    value: "flexible",
    label: "Find best window",
    description: "Find the best time for me."
  },
  {
    value: "event",
    label: "Score my planned event",
    description: "I already have a plan."
  }
];

interface PlanningModeSelectorProps {
  value: PlanningMode;
  onChange: (value: PlanningMode) => void;
}

export function PlanningModeSelector({
  value,
  onChange
}: PlanningModeSelectorProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-slate-700">Planning mode</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-3xl border p-4 text-left transition",
                selected
                  ? "border-pine bg-pine/10 shadow-sm"
                  : "border-slate-200 bg-white hover:border-slate-300"
              )}
            >
              <div className="text-sm font-semibold text-ink">{option.label}</div>
              <div className="mt-1 text-sm leading-6 text-slate-600">{option.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
