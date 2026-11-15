import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyShiftHandover } from './shift-handover-operations';

const scope = { organizationId: 'org_1', branchId: 'branch_1' };
const businessDate = new Date('2026-11-10T00:00:00.000Z');
const now = new Date('2026-11-10T18:00:00.000Z');

function fixture() {
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Main' }) },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC', currency: 'PKR' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'close_1',
        sequence: 1,
        cashExpectedMinor: 500_000,
        cashCountedMinor: 300_000,
        cashVarianceMinor: -200_000,
        reason: 'Short',
      }),
    },
    pharmacyDrawerSession: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleReturn: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleEvent: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyEmergencyRxFollowUp: {
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockResolvedValue({ createdAt: new Date('2026-11-07T10:00:00Z') }),
    },
    pharmacyCustomerOrder: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { status: 'ACCEPTED', reservationExpiresAt: new Date('2026-11-09T10:00:00Z') },
        ]),
    },
    pharmacyRestockInterest: {
      count: vi.fn(async ({ where }: { where: { reserveOnArrival?: boolean } }) =>
        where.reserveOnArrival ? 2 : 5
      ),
    },
  };
  return db;
}

describe('readPharmacyShiftHandover', () => {
  it('reads every handover figure pinned to the caller branch and drafts the note', async () => {
    const db = fixture();
    const note = await readPharmacyShiftHandover(
      db as unknown as ScopedDb,
      scope,
      businessDate,
      now
    );
    expect(note).toMatchObject({
      branchName: 'Main',
      draft: true,
      pendingRx: { count: 3, oldestAt: '2026-11-07' },
      promised: { openOrders: 1, overdueOrders: 1, restockPromises: 5, restockReserveOnArrival: 2 },
      cash: { varianceMinor: -200_000 },
      flags: [expect.objectContaining({ kind: 'CLOSE_VARIANCE' })],
    });
    const pinned = expect.objectContaining({ organizationId: 'org_1', branchId: 'branch_1' });
    expect(db.pharmacyEmergencyRxFollowUp.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'branch_1', status: 'OPEN' },
    });
    expect(db.pharmacyCustomerOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'branch_1',
          status: {
            in: ['PROPOSED', 'ACCEPTED', 'PACKING', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY'],
          },
        }),
      })
    );
    for (const call of db.pharmacyRestockInterest.count.mock.calls)
      expect(call[0].where).toEqual(pinned);
  });

  it('writes nothing and takes no lock', async () => {
    const db = fixture();
    await readPharmacyShiftHandover(db as unknown as ScopedDb, scope, businessDate, now);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('never reads a medicine, patient or customer name into the note', async () => {
    const db = fixture();
    await readPharmacyShiftHandover(db as unknown as ScopedDb, scope, businessDate, now);
    expect(db.pharmacyCustomerOrder.findMany.mock.calls[0][0].select).toEqual({
      status: true,
      reservationExpiresAt: true,
    });
  });

  it('refuses a branch outside the organization before reading handover facts', async () => {
    const db = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(
      readPharmacyShiftHandover(db as unknown as ScopedDb, scope, businessDate, now)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.pharmacyEmergencyRxFollowUp.count).not.toHaveBeenCalled();
    expect(db.pharmacyCustomerOrder.findMany).not.toHaveBeenCalled();
  });
});
