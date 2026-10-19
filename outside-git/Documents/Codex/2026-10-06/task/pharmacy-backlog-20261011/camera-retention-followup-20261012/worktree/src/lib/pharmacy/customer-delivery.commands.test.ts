import { beforeEach, expect, it, vi } from 'vitest';
import { recordDeliveryCommand } from './customer-delivery';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
import { changeSaleStatus } from './sales';
vi.mock('./settlement', () => ({
  applyPharmacyTender: vi.fn(),
  refundPharmacyTender: vi.fn(),
  saleTotalMinor: () => 1000,
}));
vi.mock('./sales', () => ({ changeSaleStatus: vi.fn(), returnSaleLine: vi.fn() }));
vi.mock('./inventory-operations', () => ({ quarantinePart: vi.fn() }));
vi.mock('./customer-ordering', () => ({ releaseOrderReservations: vi.fn() }));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier' };
function fixture() {
  const sale = {
    id: 'sale-a',
    status: 'OPEN',
    lines: [],
    tenders: [{ id: 'tender-a', type: 'CASH', amountMinor: 400, refunds: [] }],
  };
  const order = {
    id: 'order-a',
    ...scope,
    status: 'OUT_FOR_DELIVERY',
    fulfillment: 'DELIVER',
    intendedPaymentMethod: 'CASH',
    runnerUserId: 'runner',
    counterSaleId: sale.id,
    counterSale: sale,
    deliveryEvidence: [
      { action: 'COLLECT', amountMinor: 400, requestKey: 'collect-a' },
      { action: 'REMIT', amountMinor: 400, requestKey: 'remit-a' },
      { action: 'REFUSED', amountMinor: null, requestKey: 'refuse-a' },
    ],
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyCustomerOrder: { findFirst: vi.fn().mockResolvedValue(order), update: vi.fn() },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue(sale) },
    pharmacyOrderDeliveryEvidence: {
      create: vi.fn(async ({ data }) => ({ id: 'evidence-a', ...data })),
    },
  };
  return { db, order, sale };
}
beforeEach(() => vi.clearAllMocks());
it('refunds actual partial cash before voiding a physically returned open sale', async () => {
  const { db } = fixture();
  await recordDeliveryCommand(db as never, scope, {
    branchId: scope.branchId,
    orderId: 'order-a',
    action: 'PHYSICAL_RETURN',
    reference: 'received-by-cashier',
    requestKey: 'return-a',
    deviceId: 'device-a',
    businessDate: new Date('2026-10-08'),
  });
  expect(refundPharmacyTender).toHaveBeenCalledWith(
    db,
    scope,
    expect.objectContaining({ originalTenderId: 'tender-a', amountMinor: 400 })
  );
  expect(changeSaleStatus).toHaveBeenCalledWith(db, scope, 'sale-a', 'void', expect.any(String));
  expect(vi.mocked(refundPharmacyTender).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(changeSaleStatus).mock.invocationCallOrder[0]
  );
  expect(db.pharmacyCustomerOrder.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: 'RETURNED' } })
  );
});
it('propagates refund failure before return evidence or reservation-release state', async () => {
  const { db } = fixture();
  vi.mocked(refundPharmacyTender).mockRejectedValueOnce(new Error('DRAWER_NOT_OPEN'));
  await expect(
    recordDeliveryCommand(db as never, scope, {
      branchId: scope.branchId,
      orderId: 'order-a',
      action: 'PHYSICAL_RETURN',
      reference: 'received',
      requestKey: 'return-a',
      deviceId: 'device-a',
      businessDate: new Date('2026-10-08'),
    })
  ).rejects.toThrow('DRAWER_NOT_OPEN');
  expect(changeSaleStatus).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
});
it('records actual remittance through ordinary cash tender before custody evidence', async () => {
  const { db, order } = fixture();
  order.deliveryEvidence = [{ action: 'COLLECT', amountMinor: 400, requestKey: 'collect-a' }];
  await recordDeliveryCommand(db as never, scope, {
    branchId: scope.branchId,
    orderId: 'order-a',
    action: 'REMIT',
    amountMinor: 300,
    reference: 'cash-received',
    requestKey: 'remit-a',
    deviceId: 'device-a',
    businessDate: new Date('2026-10-08'),
  });
  expect(applyPharmacyTender).toHaveBeenCalledWith(
    db,
    scope,
    expect.objectContaining({ type: 'CASH', amountMinor: 300, cashReceivedMinor: 300 })
  );
});

it('rejects a conflicting trusted branch before rebinding, reading orders or writing evidence', async () => {
  const { db } = fixture();
  db.$queryRaw.mockResolvedValueOnce([{ branchId: 'restricted-other-branch' }]);
  await expect(
    recordDeliveryCommand(db as never, scope, {
      branchId: scope.branchId,
      orderId: 'order-a',
      action: 'REFUSED',
      reference: 'synthetic refusal',
      requestKey: 'foreign-branch',
    })
  ).rejects.toThrow('ORDER_NOT_FOUND');
  expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  expect(db.pharmacyCustomerOrder.findFirst).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
  expect(applyPharmacyTender).not.toHaveBeenCalled();
});
