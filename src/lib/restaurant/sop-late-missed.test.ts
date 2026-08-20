/**
 * M7-L4 — SOP late/missed sweep unit tests.
 * Covers: happy path (updateMany + queryRaw called), payload schema validation,
 * injectable clock (deterministic now).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sopLateMissedHandler } from './sop-late-missed';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

function makeContext(payloadOverride: Record<string, unknown> = {}): RestaurantJobContext {
  const db = {
    restaurantSopOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  } as unknown as ScopedDb;

  return {
    db,
    job: {
      id: 'job_1',
      type: 'sop.sweepLateMissed',
      payload: payloadOverride,
      organizationId: 'org_1',
      status: 'RUNNING',
      attempts: 1,
      maxAttempts: 5,
      scheduledAt: new Date(),
      nextAttemptAt: new Date(),
      claimedAt: new Date(),
      claimedBy: 'worker_1',
      lastError: null,
      idempotencyKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

describe('sopLateMissedHandler', () => {
  it('calls updateMany (LATE sweep) and $queryRaw (MISSED sweep)', async () => {
    const ctx = makeContext({ now: '2026-08-20T12:00:00.000Z' });
    await sopLateMissedHandler(ctx);

    expect((ctx.db as Record<string, { updateMany: ReturnType<typeof vi.fn> }>).restaurantSopOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        }),
        data: { status: 'LATE' },
      })
    );
    expect((ctx.db as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).toHaveBeenCalledOnce();
  });

  it('works with an empty payload (uses current time)', async () => {
    const ctx = makeContext();
    await expect(sopLateMissedHandler(ctx)).resolves.toBeUndefined();
  });

  it('rejects an unknown payload key (strict zod)', async () => {
    const ctx = makeContext({ unknown: true });
    await expect(sopLateMissedHandler(ctx)).rejects.toThrow();
  });
});
