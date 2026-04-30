interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <section className="rounded-[2rem] border border-coral/20 bg-rose-50 p-6 text-sm leading-7 text-slate-700 shadow-panel">
      <h2 className="text-xl font-semibold text-ink">We hit a snag</h2>
      <p className="mt-3">{message}</p>
      <p className="mt-2 text-slate-600">
        Check the location and try again in a moment. If weather data is temporarily unavailable, the app cannot make a recommendation.
      </p>
    </section>
  );
}
