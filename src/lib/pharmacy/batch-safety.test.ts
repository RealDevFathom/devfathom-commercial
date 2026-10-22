import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  assertSaleBatchesSafeForSettlement,
  PharmacyBatchSafetyError,
  type PharmacyBatchSafetyBlocker,
} from './batch-safety';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const at = new Date('2026-10-22T12:00:00.000Z');

function dbWith(blocker: PharmacyBatchSafetyBlocker | null) {
  return { $queryRaw: vi.fn().mockResolvedValue([{ blocker }]) };
}

describe('settlement-time batch safety', () => {
  it.each(['RECALLED', 'QUARANTINED', 'EXPIRED'] as const)(
    'rejects a batch that became %s after it was added to the cart',
    async (blocker) => {
      const db = dbWith(blocker);

      await expect(
        assertSaleBatchesSafeForSettlement(db as never, scope, 'sale-1', at)
      ).rejects.toEqual(
        expect.objectContaining<Partial<PharmacyBatchSafetyError>>({
          name: 'PharmacyBatchSafetyError',
          reason: 'BLOCKED_STOCK',
          blocker,
        })
      );
    }
  );

  it('allows settlement only after the locked re-read reports every batch safe', async () => {
    const db = dbWith(null);

    await expect(
      assertSaleBatchesSafeForSettlement(db as never, scope, 'sale-1', at)
    ).resolves.toBeUndefined();

    const query = db.$queryRaw.mock.calls[0]![0] as { strings: readonly string[]; values: unknown[] };
    expect(query.strings.join(' ')).toContain('FOR UPDATE');
    expect(query.values).toEqual(
      expect.arrayContaining(['org-1', 'branch-1', 'sale-1', at])
    );
  });
});
