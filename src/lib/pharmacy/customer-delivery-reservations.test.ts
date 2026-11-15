import { expect, it, vi } from 'vitest';
import { optOutRestockInterest, recoverRestockInterest } from './sales';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'staff-a' };
it('ordinary restock opt-out cannot release order-bound physical custody', async () => {
  const release = vi.fn();
  const db = {
    pharmacyRestockInterest: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'interest-a', status: 'NOTIFIED', orderLineId: 'order-line-a' }),
      update: vi.fn(),
    },
    pharmacyRestockNotification: { updateMany: vi.fn() },
    pharmacyRestockReservation: { updateMany: release },
  };
  await expect(optOutRestockInterest(db as never, scope, 'interest-a')).rejects.toThrow(
    'INVALID_STATE'
  );
  expect(release).not.toHaveBeenCalled();
});
it('ordinary restock recovery cannot consume order reservations against another receipt', async () => {
  const consume = vi.fn();
  const db = {
    pharmacyRestockInterest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'interest-a',
        orderLineId: 'order-line-a',
        demandEventId: 'demand-a',
        demandEvent: { requestedMedicineId: 'medicine-a' },
      }),
      update: vi.fn(),
    },
    pharmacySaleLine: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'line-b',
        medicineId: 'medicine-a',
        sale: { status: 'COMPLETED', receiptNumber: 1 },
      }),
    },
    unfulfilledDemandEvent: { update: vi.fn() },
    pharmacyRestockReservation: { updateMany: consume },
  };
  await expect(
    recoverRestockInterest(db as never, scope, { interestId: 'interest-a', saleLineId: 'line-b' })
  ).rejects.toThrow('INVALID_STATE');
  expect(consume).not.toHaveBeenCalled();
});
it('ordinary restock opt-out and recovery cannot settle a refill-subscription hold (DEV-73)', async () => {
  const settle = vi.fn();
  const interest = {
    id: 'interest-r',
    status: 'OPEN',
    orderLineId: null,
    campaignKey: 'refill-cycle:cycle-a',
    demandEventId: 'demand-r',
    demandEvent: { requestedMedicineId: 'medicine-a' },
  };
  const db = {
    pharmacyRestockInterest: { findFirst: vi.fn().mockResolvedValue(interest), update: vi.fn() },
    pharmacyRestockNotification: { updateMany: vi.fn() },
    pharmacySaleLine: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'line-b',
        medicineId: 'medicine-a',
        sale: { status: 'COMPLETED', receiptNumber: 1 },
      }),
    },
    unfulfilledDemandEvent: { update: vi.fn() },
    pharmacyRestockReservation: { updateMany: settle },
  };
  await expect(optOutRestockInterest(db as never, scope, 'interest-r')).rejects.toThrow(
    'INVALID_STATE'
  );
  await expect(
    recoverRestockInterest(db as never, scope, { interestId: 'interest-r', saleLineId: 'line-b' })
  ).rejects.toThrow('INVALID_STATE');
  expect(settle).not.toHaveBeenCalled();
});
