export const DONE_COLUMN_RE = /^(done|complete|completed|shipped|closed)$/i;

/** Return the persisted completion timestamp after a column transition. */
export function completionTimeAfterMove(
  sourceColumnName: string,
  targetColumnName: string,
  movedAt: Date
): Date | null | undefined {
  const wasDone = DONE_COLUMN_RE.test(sourceColumnName);
  const isDone = DONE_COLUMN_RE.test(targetColumnName);

  if (!wasDone && isDone) return movedAt;
  if (wasDone && !isDone) return null;
  return undefined;
}
