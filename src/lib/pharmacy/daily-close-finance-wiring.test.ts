import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const dependencies = vi.hoisted(() => ({
  postDailyCloseEntry: vi.fn(),
  requestCounterEvidence: vi.fn(),
}));

vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postDailyCloseEntry: dependencies.postDailyCloseEntry,
}));
vi.mock('./counter-evidence', () => ({
  requestCounterEvidence: dependencies.requestCounterEvidence,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { cutPharmacyDailyClose } from './settlement';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const createdAt = new Date('2026-10-22T18:00:00Z');

function fixture() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyDrawerSession: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'drawer-1',
          countedCashMinor: 9_900,
          movements: [{ kind: 'OPENING_FLOAT', amountMinor: 10_000 }],
        },
      ]),
    },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: 'close-1', createdAt, ...data })),
    },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyParallelRunWindow: { count: vi.fn().mockResolvedValue(0) },
  };
}

describe('daily close finance posting wiring', () => {
  beforeEach(() => {
    dependencies.postDailyCloseEntry.mockReset();
    dependencies.requestCounterEvidence.mockReset();
  });

  it('posts the persisted cash variance before requesting counter evidence', async () => {
    const db = fixture();

    await expect(
      cutPharmacyDailyClose(db as unknown as ScopedDb, scope, {
        businessDate: new Date('2026-10-22T00:00:00Z'),
      })
    ).resolves.toMatchObject({ id: 'close-1', cashVarianceMinor: -100 });

    expect(dependencies.postDailyCloseEntry).toHaveBeenCalledWith(db, scope, {
      closeId: 'close-1',
      at: createdAt,
    });
    expect(dependencies.postDailyCloseEntry.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.requestCounterEvidence.mock.invocationCallOrder[0]!
    );
  });

  it('does not continue when the finance posting fails', async () => {
    const db = fixture();
    dependencies.postDailyCloseEntry.mockRejectedValueOnce(new Error('journal unavailable'));

    await expect(
      cutPharmacyDailyClose(db as unknown as ScopedDb, scope, {
        businessDate: new Date('2026-10-22T00:00:00Z'),
      })
    ).rejects.toThrow('journal unavailable');

    expect(dependencies.requestCounterEvidence).not.toHaveBeenCalled();
  });
});
