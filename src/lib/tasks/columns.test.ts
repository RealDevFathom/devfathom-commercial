import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { updateColumnWithCompletion } from './columns';

describe('column rename completion', () => {
  it.each([
    ['To Do', 'Done', true],
    ['Done', 'In Progress', false],
    ['Closed', ' Done ', undefined],
    ['To Do', 'In Progress', undefined],
    ['Done', undefined, undefined],
  ] as const)('maintains timestamps for %s → %s', async (source, target, completes) => {
    const now = new Date('2026-10-31T12:00:00.000Z');
    const tx = {
      $queryRaw: vi.fn(async () => []),
      column: {
        findUniqueOrThrow: vi.fn(async () => ({ name: source })),
        update: vi.fn(async () => ({ id: 'column-1', name: target ?? source })),
      },
      task: { updateMany: vi.fn(async () => ({ count: 2 })) },
    };
    const db = {
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    };

    await updateColumnWithCompletion(
      db as unknown as ScopedDb,
      'column-1',
      { name: target, wipLimit: 3 },
      now
    );

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.column.findUniqueOrThrow.mock.invocationCallOrder[0]
    );
    expect(tx.column.update).toHaveBeenCalledWith({
      where: { id: 'column-1' },
      data: { name: target, wipLimit: 3 },
    });
    if (completes === undefined) {
      expect(tx.task.updateMany).not.toHaveBeenCalled();
    } else {
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { columnId: 'column-1' },
        data: { completedAt: completes ? now : null },
      });
    }
  });
});
