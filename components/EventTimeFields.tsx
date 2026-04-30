"use client";

interface EventTimeFieldsProps {
  eventStartDate: string;
  eventEndDate: string;
  eventStartTime: string;
  eventEndTime: string;
  suggestAlternates: boolean;
  helperText?: string;
  onEventStartDateChange: (value: string) => void;
  onEventEndDateChange: (value: string) => void;
  onEventStartTimeChange: (value: string) => void;
  onEventEndTimeChange: (value: string) => void;
  onSuggestAlternatesChange: (value: boolean) => void;
}

export function EventTimeFields({
  eventStartDate,
  eventEndDate,
  eventStartTime,
  eventEndTime,
  suggestAlternates,
  helperText,
  onEventStartDateChange,
  onEventEndDateChange,
  onEventStartTimeChange,
  onEventEndTimeChange,
  onSuggestAlternatesChange
}: EventTimeFieldsProps) {
  return (
    <div className="space-y-4 rounded-3xl border border-slate-200 bg-mist/70 p-4">
      <div>
        <p className="text-sm font-medium text-slate-700">Planned event details</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Score a specific outdoor window in the forecast location&apos;s local time.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">Start date</span>
          <input
            type="date"
            value={eventStartDate}
            onChange={(event) => onEventStartDateChange(event.target.value)}
            className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition focus:border-tide focus:ring-4 focus:ring-sky/60"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">Start time</span>
          <input
            type="time"
            value={eventStartTime}
            onChange={(event) => onEventStartTimeChange(event.target.value)}
            className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition focus:border-tide focus:ring-4 focus:ring-sky/60"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">End date</span>
          <input
            type="date"
            value={eventEndDate}
            onChange={(event) => onEventEndDateChange(event.target.value)}
            className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition focus:border-tide focus:ring-4 focus:ring-sky/60"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">End time</span>
          <input
            type="time"
            value={eventEndTime}
            onChange={(event) => onEventEndTimeChange(event.target.value)}
            className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition focus:border-tide focus:ring-4 focus:ring-sky/60"
          />
        </label>
      </div>

      {helperText ? (
        <p className="rounded-2xl bg-white px-4 py-3 text-sm leading-6 text-slate-600">
          {helperText}
        </p>
      ) : null}

      <label className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={suggestAlternates}
          onChange={(event) => onSuggestAlternatesChange(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-pine focus:ring-pine"
        />
        <span>Suggest better times if conditions are poor</span>
      </label>
    </div>
  );
}
