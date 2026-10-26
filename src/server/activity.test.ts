import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindSideEffects } from '@/lib/side-effects/scope';

import { logActivity } from './activity';

describe('logActivity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('remains fire-and-forget outside a tenant transaction', () => {
    const create = vi.fn(() => new Promise<void>(() => undefined));
    const db = { activity: { create } } as never;

    expect(
      logActivity(db, 'user-1', {
        type: 'project_created',
        message: 'created project Alpha',
      })
    ).toBeUndefined();
    expect(create).toHaveBeenCalledWith({
      data: {
        type: 'project_created',
        message: 'created project Alpha',
        userId: 'user-1',
        entityType: null,
        entityId: null,
        metadata: undefined,
      },
    });
  });

  it('keeps a tenant transaction open until the activity insert settles', async () => {
    let finishWrite!: () => void;
    const create = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const db = { activity: { create } } as never;

    await bindSideEffects(async (scope) => {
      logActivity(db, 'user-1', {
        type: 'project_created',
        message: 'created project Alpha',
        entityType: 'Project',
        entityId: 'project-1',
      });

      expect(scope.enqueued).toBe(false);
      expect(scope.pending).toHaveLength(1);

      let flushed = false;
      const flush = scope.flush().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBe(false);

      finishWrite();
      await flush;
      expect(flushed).toBe(true);
    });
  });

  it('continues to swallow activity insert failures', async () => {
    const error = new Error('write failed');
    const db = { activity: { create: vi.fn().mockRejectedValue(error) } } as never;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await bindSideEffects(async (scope) => {
      logActivity(db, 'user-1', {
        type: 'project_created',
        message: 'created project Alpha',
      });
      await expect(scope.flush()).resolves.toBeUndefined();
    });

    expect(consoleError).toHaveBeenCalledWith(
      '[activity] failed to log',
      'project_created',
      error
    );
  });

  it('waits for every activity insert without scheduling an outbox drain', async () => {
    const finishWrites: Array<() => void> = [];
    const create = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrites.push(resolve);
        })
    );
    const db = { activity: { create } } as never;

    await bindSideEffects(async (scope) => {
      logActivity(db, 'user-1', { type: 'project_created', message: 'created Alpha' });
      logActivity(db, 'user-1', { type: 'project_updated', message: 'updated Alpha' });

      expect(scope.enqueued).toBe(false);
      expect(scope.pending).toHaveLength(2);

      let flushed = false;
      const flush = scope.flush().then(() => {
        flushed = true;
      });

      finishWrites[0]();
      await Promise.resolve();
      expect(flushed).toBe(false);

      finishWrites[1]();
      await flush;
      expect(flushed).toBe(true);
    });
  });
});
