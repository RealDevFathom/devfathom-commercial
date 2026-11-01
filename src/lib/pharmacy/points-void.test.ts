import { describe, expect, it, vi } from 'vitest';
import { restoreVoidedSalePoints } from './points-void';
import { refundPharmacyTender } from './settlement';
vi.mock('./settlement', () => ({ refundPharmacyTender: vi.fn() }));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
it('reverses only the unrefunded loyalty tender on a void through the audited refund service', async () => {
  const day = new Date('2026-10-29');
  const db = {
    $queryRaw: vi.fn(),
    pharmacySale: { findFirst: vi.fn(async () => ({ customerId: 'customer' })) },
    pharmacyTender: {
      findMany: vi.fn(async () => [
        {
          id: 'tender',
          amountMinor: 1000,
          refunds: [{ amountMinor: 300 }],
          deviceId: 'device',
          businessDate: day,
        },
      ]),
    },
  };
  await restoreVoidedSalePoints(db as never, scope, 'sale');
  expect(refundPharmacyTender).toHaveBeenCalledWith(
    db,
    scope,
    expect.objectContaining({
      originalTenderId: 'tender',
      amountMinor: 700,
      deviceId: 'device',
      businessDate: day,
      idempotencyKey: 'loyalty:void:sale:tender',
    })
  );
  vi.mocked(refundPharmacyTender).mockClear();
  db.pharmacyTender.findMany.mockResolvedValue([
    {
      id: 'tender',
      amountMinor: 1000,
      refunds: [{ amountMinor: 1000 }],
      deviceId: 'device',
      businessDate: day,
    },
  ]);
  await restoreVoidedSalePoints(db as never, scope, 'sale');
  expect(refundPharmacyTender).not.toHaveBeenCalled();
  expect(db.pharmacySale.findFirst).toHaveBeenCalledWith({
    where: { id: 'sale', organizationId: 'org', branchId: 'branch', status: 'VOID' },
  });
});
describe('void without points', () => {
  it('does not enroll or create points for an unlinked customer', async () => {
    const db = {
      $queryRaw: vi.fn(),
      pharmacySale: { findFirst: vi.fn(async () => ({ customerId: null })) },
    };
    expect(await restoreVoidedSalePoints(db as never, scope, 'sale')).toBeNull();
  });
});
