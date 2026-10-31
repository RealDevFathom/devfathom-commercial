import { describe, expect, it, vi } from 'vitest';
import { withProjectMembershipChanges } from './project-membership';

function sharedTransaction() {
  const tx = { $queryRaw: vi.fn(async () => [{ id: 'project_1' }]) };
  const db = { $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx) };
  return { db: db as never, tx };
}

describe('membership critical sections within a shared transaction', () => {
  it('waits for the full check and write before starting the next operation', async () => {
    const { db, tx } = sharedTransaction();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    const events: string[] = [];
    const first = withProjectMembershipChanges(db, 'project_1', 'org_1', async () => {
      events.push('check first');
      started();
      await pending;
      events.push('write first');
    });
    await entered;
    const second = withProjectMembershipChanges(db, 'project_1', 'org_1', async () => {
      events.push('check second');
      events.push('write second');
    });
    try {
      await Promise.resolve();
      expect(tx.$queryRaw).toHaveBeenCalledOnce();
      expect(events).toEqual(['check first']);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(events).toEqual(['check first', 'write first', 'check second', 'write second']);
  });

  it('lets different projects and transactions proceed independently', async () => {
    const { db } = sharedTransaction();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const first = withProjectMembershipChanges(db, 'project_1', 'org_1', () => pending);
    try {
      await expect(
        withProjectMembershipChanges(db, 'project_2', 'org_1', async () => 'other project')
      ).resolves.toBe('other project');
      await expect(
        withProjectMembershipChanges(
          sharedTransaction().db,
          'project_1',
          'org_1',
          async () => 'other transaction'
        )
      ).resolves.toBe('other transaction');
    } finally {
      release();
      await first;
    }
  });

  it.each(['lock', 'operation'])('releases the queue after a rejected %s', async (failure) => {
    const { db, tx } = sharedTransaction();
    if (failure === 'lock') tx.$queryRaw.mockResolvedValueOnce([]);
    const operation = vi.fn(async () => {
      throw new Error('membership rejected');
    });
    const first = withProjectMembershipChanges(db, 'project_1', 'org_1', operation);
    const rejected = expect(first).rejects.toThrow(
      failure === 'lock' ? 'Project not found.' : 'membership rejected'
    );
    const second = withProjectMembershipChanges(
      db,
      'project_1',
      'org_1',
      async () => 'next operation'
    );
    await rejected;
    await expect(second).resolves.toBe('next operation');
    expect(operation).toHaveBeenCalledTimes(failure === 'lock' ? 0 : 1);
  });
});
