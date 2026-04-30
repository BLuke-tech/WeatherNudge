"use client";

interface ZipInputFormProps {
  value: string;
  onChange: (value: string) => void;
}

export function ZipInputForm({ value, onChange }: ZipInputFormProps) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-700">Location</span>
      <input
        inputMode="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="ZIP code or City, ST"
        className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition focus:border-tide focus:ring-4 focus:ring-sky/60"
        aria-label="Location"
      />
    </label>
  );
}
