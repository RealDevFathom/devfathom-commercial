import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const settlement = vi.hoisted(() => ({
  closePharmacyDrawer: vi.fn(),
  cutPharmacyDailyClose: vi.fn(),
  lockPharmacyDay: vi.fn(),
}));

vi.mock('./settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settlement')>()),
  ...settlement,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { closePharmacyDay, readPharmacyClose } from './day-close';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
const businessDate = new Date('2026-10-21T00:00:00.000Z');

function fixture() {
  const drawers = Array.from({ length: 4 }, (_, index) => ({
    id: `drawer-${index + 1}`,
    deviceId: `counter-${index + 1}`,
    status: 'OPEN',
    openedAt: new Date(`2026-10-21T0${index + 1}:00:00.000Z`),
    openedByActorId: 'owner',
    countedCashMinor: null,
    movements: [],
  }));
  const db = {
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Main branch' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue(null),
      // Deliberately present so the regression assertion detects any follow-up mutation.
      update: vi.fn().mockRejectedValue(new Error('pharmacy_daily_closes is append-only')),
    },
    pharmacyDrawerSession: { findMany: vi.fn().mockResolvedValue(drawers) },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyTender: { findMany: vi.fn().mockResolvedValue([]) },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner', name: 'Owner' }]) },
  };
  return { db, drawers, scoped: db as unknown as ScopedDb };
}

describe('append-only pharmacy day close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlement.cutPharmacyDailyClose.mockResolvedValue({ id: 'close-1', reason: null });
  });

  it('inserts the final report with its note and never updates it after all drawers are counted', async () => {
    const { db, drawers, scoped } = fixture();
    const preview = await readPharmacyClose(scoped, scope, businessDate);
    const counts = drawers.map((drawer) => ({
      drawerSessionId: drawer.id,
      countedCashMinor: 0,
    }));

    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate,
        sourceHash: preview.totals.sourceHash,
        counts,
        varianceNote: '',
      })
    ).resolves.toEqual({ id: 'close-1', reason: null });

    expect(settlement.closePharmacyDrawer).toHaveBeenCalledTimes(4);
    expect(settlement.cutPharmacyDailyClose).toHaveBeenCalledOnce();
    expect(settlement.cutPharmacyDailyClose).toHaveBeenCalledWith(scoped, scope, {
      businessDate,
      varianceNote: '',
    });
    expect(db.pharmacyDailyClose.update).not.toHaveBeenCalled();
  });
});
