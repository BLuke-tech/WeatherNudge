export function shouldRevealResults(params: {
  isLoading: boolean;
  hasResult: boolean;
  completedRunId: number | null;
  revealedRunId: number | null;
}) {
  const { isLoading, hasResult, completedRunId, revealedRunId } = params;

  if (isLoading) return false;
  if (!hasResult) return false;
  if (completedRunId === null) return false;

  return completedRunId !== revealedRunId;
}
