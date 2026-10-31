/** Keep completion semantics consistent across every task write surface. */
export const DONE_COLUMN_PATTERN = /^(done|complete|completed|shipped|closed)$/i;

export function isDoneColumn(name: string): boolean {
  return DONE_COLUMN_PATTERN.test(name.trim());
}

export function completionTimestampForMove(
  sourceColumnName: string,
  targetColumnName: string,
  now: Date = new Date()
): Date | null | undefined {
  const wasDone = isDoneColumn(sourceColumnName);
  const isDone = isDoneColumn(targetColumnName);
  if (!wasDone && isDone) return now;
  if (wasDone && !isDone) return null;
  return undefined;
}
