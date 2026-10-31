import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { completionTimestampForMove } from './completion';

/** A rename can complete or reopen every task in a column. */
export function updateColumnWithCompletion(
  db: ScopedDb,
  id: string,
  data: { name?: string; wipLimit?: number | null },
  now: Date = new Date()
) {
  return db.$transaction(async (tx) => {
    // Use the same column lock as task moves, then read the current name.
    await tx.$queryRaw`SELECT id FROM columns WHERE id = ${id} FOR UPDATE`;
    const current = await tx.column.findUniqueOrThrow({ where: { id }, select: { name: true } });
    const completedAt =
      data.name === undefined
        ? undefined
        : completionTimestampForMove(current.name, data.name, now);
    const column = await tx.column.update({ where: { id }, data });
    if (completedAt !== undefined) {
      await tx.task.updateMany({ where: { columnId: id }, data: { completedAt } });
    }
    return column;
  });
}
