"use client";

import { TimeHorizon } from "@/lib/types";
import { cn } from "@/lib/utils";

const options: Array<{ value: TimeHorizon; label: string }> = [
  { value: "today", label: "Today" },
  { value: "tonight", label: "Tonight" },
  { value: "24h", label: "Next 24 hours" },
  { value: "48h", label: "Next 48 hours" }
];

interface TimeHorizonSelectorProps {
  value: TimeHorizon;
  onChange: (value: TimeHorizon) => void;
}

export function TimeHorizonSelector({
  value,
  onChange
}: TimeHorizonSelectorProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-slate-700">Time horizon</p>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-full border px-4 py-2 text-sm font-medium transition",
                selected
                  ? "border-pine bg-pine text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
