/**
 * When a task was completed (DEV-250 / #450).
 *
 * A task is done while it sits in a column with a done name — the same
 * case-insensitive heuristic the board uses (Done, Complete, Completed, Shipped,
 * Closed). `Task.completedAt` records the moment it ENTERED that state, so
 * /team/stats can count completions without reading `updatedAt`, which every
 * ordinary edit bumps.
 *
 * Every path that creates a task, changes its column, or renames a column (which
 * can change whether the tasks in it are done) derives `completedAt` here:
 *   - creating a task straight into a done column sets it to now;
 *   - entering a done column from a non-done one sets it to now;
 *   - moving between done columns, or reordering inside one, keeps it;
 *   - leaving done clears it;
 *   - edits that do not change the column never touch it.
 *
 * Plain module (no server-only, no Prisma import) so seeds and scripts can share it.
 */

export const DONE_COLUMN_NAMES = ['done', 'complete', 'completed', 'shipped', 'closed'] as const;

/** Whether a column with this name holds finished work. */
export function isDoneColumnName(name: string | null | undefined): boolean {
  return (
    typeof name === 'string' &&
    (DONE_COLUMN_NAMES as readonly string[]).includes(name.toLowerCase())
  );
}

/** Whether moving from `fromColumnName` (null = creating) to `toColumnName` completes the task. */
export function entersDone(fromColumnName: string | null, toColumnName: string): boolean {
  return isDoneColumnName(toColumnName) && !isDoneColumnName(fromColumnName);
}

/** Spread into Prisma task `data`; `{}` leaves `completedAt` untouched. */
export type CompletedAtWrite = { completedAt?: Date | null };

/**
 * The `completedAt` write for a task landing in the column named `toColumnName`.
 * `fromColumnName` is the column it leaves, or `null` when the task is being created.
 */
export function completedAtForColumnChange(
  fromColumnName: string | null,
  toColumnName: string,
  now: Date = new Date()
): CompletedAtWrite {
  if (!isDoneColumnName(toColumnName)) return { completedAt: null };
  if (fromColumnName !== null && isDoneColumnName(fromColumnName)) return {};
  return { completedAt: now };
}

/** The minimal client `syncCompletionForColumnRename` needs (a Prisma client or transaction). */
export type TaskCompletionDb = {
  task: {
    updateMany(args: {
      where: { columnId: string; completedAt?: null };
      data: { completedAt: Date | null };
    }): PromiseLike<unknown>;
  };
};

/**
 * Renaming a column can move every task in it into or out of done. Applies that
 * transition to the column's tasks; a rename that keeps done-ness (Done → Shipped,
 * To Do → Doing) changes nothing. Returns whether anything was written.
 */
export async function syncCompletionForColumnRename(
  db: TaskCompletionDb,
  columnId: string,
  fromName: string,
  toName: string,
  now: Date = new Date()
): Promise<boolean> {
  const wasDone = isDoneColumnName(fromName);
  const isDone = isDoneColumnName(toName);
  if (wasDone === isDone) return false;
  if (isDone) {
    await db.task.updateMany({
      where: { columnId, completedAt: null },
      data: { completedAt: now },
    });
  } else {
    await db.task.updateMany({ where: { columnId }, data: { completedAt: null } });
  }
  return true;
}
