/**
 * M7-L4 — SOP late/missed sweep unit tests.
 * Covers: happy path (updateMany + queryRaw called), payload schema validation,
 * injectable clock (deterministic now).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sopLateMissedHandler } from './sop-late-missed';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

function makeContext(payloadOverride: Record<string, unknown> = {}): {
  ctx: RestaurantJobContext;
  updateMany: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const queryRaw = vi.fn().mockResolvedValue([]);

  const db = {
    restaurantSopOccurrence: { updateMany },
    $queryRaw: queryRaw,
  } as unknown as ScopedDb;

  const ctx: RestaurantJobContext = {
    db,
    job: {
      id: 'job_1',
      type: 'sop.sweepLateMissed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payloadOverride as any,
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'worker_1',
      startedAt: new Date(),
    },
  };

  return { ctx, updateMany, queryRaw };
}

describe('sopLateMissedHandler', () => {
  it('calls updateMany (LATE sweep) and $queryRaw (MISSED sweep)', async () => {
    const { ctx, updateMany, queryRaw } = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        }),
        data: { status: 'LATE' },
      })
    );
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('works with an empty payload (uses current time)', async () => {
    const { ctx } = makeContext();
    await expect(sopLateMissedHandler(ctx)).resolves.toBeUndefined();
  });

  it('rejects an unknown payload key (strict zod)', async () => {
    const { ctx } = makeContext({ unknown: true });
    await expect(sopLateMissedHandler(ctx)).rejects.toThrow();
  });
});
