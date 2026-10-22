import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ trackSideEffect: vi.fn() }));

vi.mock('@/lib/side-effects/scope', () => ({ trackSideEffect: mocks.trackSideEffect }));

import { logActivity } from './activity';

describe('logActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers its write so a tenant transaction cannot close while it is pending', async () => {
    let finishWrite!: () => void;
    const create = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );

    logActivity({ activity: { create } } as never, 'user-1', {
      type: 'project_created',
      message: 'created project One',
      entityType: 'Project',
      entityId: 'project-1',
    });

    expect(mocks.trackSideEffect).toHaveBeenCalledOnce();
    const tracked = mocks.trackSideEffect.mock.calls[0]![0] as Promise<unknown>;
    let settled = false;
    void tracked.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishWrite();
    await tracked;
    expect(settled).toBe(true);
  });

  it('swallows write failures without putting error details or metadata in logs', async () => {
    const error = Object.assign(new Error('secret query value'), { code: 'P2028' });
    const create = vi.fn().mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logActivity({ activity: { create } } as never, 'user-1', {
      type: 'note_created',
      message: 'created secret note',
      metadata: { token: 'do-not-log' },
    });

    const tracked = mocks.trackSideEffect.mock.calls[0]![0] as Promise<unknown>;
    await expect(tracked).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('[activity] failed to log', 'note_created', 'P2028');
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('secret'));
  });
});
