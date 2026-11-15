import { beforeEach, expect, it, vi } from 'vitest';
import { recordDeliveryCommand } from './customer-delivery';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
import { changeSaleStatus, returnSaleLine } from './sales';
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
  await recordDeliveryCommand(
    db as never,
    scope,
    {
      branchId: scope.branchId,
      orderId: 'order-a',
      action: 'PHYSICAL_RETURN',
      reference: 'received-by-cashier',
      requestKey: 'return-a',
      deviceId: 'device-a',
      businessDate: new Date('2026-10-08'),
    },
    { authorizeRefund: async () => {} }
  );
  expect(refundPharmacyTender).toHaveBeenCalledWith(
    db,
    scope,
    expect.objectContaining({ originalTenderId: 'tender-a', amountMinor: 400 }),
    // DEV-821: reached only after the manager/owner refund authorization.
    { drawerOperator: { kind: 'COUNTER', actorIsManager: true } }
  );
  expect(changeSaleStatus).toHaveBeenCalledWith(
    db,
    scope,
    'sale-a',
    'void',
    { kind: 'FAILED_DELIVERY_RETURN' },
    expect.any(String)
  );
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
    recordDeliveryCommand(
      db as never,
      scope,
      {
        branchId: scope.branchId,
        orderId: 'order-a',
        action: 'PHYSICAL_RETURN',
        reference: 'received',
        requestKey: 'return-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-08'),
      },
      { authorizeRefund: async () => {} }
    )
  ).rejects.toThrow('DRAWER_NOT_OPEN');
  expect(changeSaleStatus).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
});
const physicalReturn = {
  branchId: scope.branchId,
  orderId: 'order-a',
  action: 'PHYSICAL_RETURN' as const,
  reference: 'received',
  requestKey: 'return-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-10-08'),
};
it('DEV-647: refuses a cash-refunding physical return without a refund authorizer', async () => {
  const { db } = fixture();
  await expect(recordDeliveryCommand(db as never, scope, physicalReturn)).rejects.toThrow(
    'REFUND_AUTHORIZATION_REQUIRED'
  );
  expect(refundPharmacyTender).not.toHaveBeenCalled();
  expect(changeSaleStatus).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
});
it('DEV-647: authorizes once before any refund and stops when authorization is refused', async () => {
  const { db } = fixture();
  const authorizeRefund = vi.fn(async () => {
    throw new Error('Only a manager or owner can refund.');
  });
  await expect(
    recordDeliveryCommand(db as never, scope, physicalReturn, { authorizeRefund })
  ).rejects.toThrow('Only a manager or owner can refund.');
  expect(authorizeRefund).toHaveBeenCalledOnce();
  expect(refundPharmacyTender).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
});
it('DEV-647: needs no refund authorizer when every tender is already refunded', async () => {
  const { db, sale } = fixture();
  sale.tenders = [
    {
      id: 'tender-a',
      type: 'CASH',
      amountMinor: 400,
      refunds: [{ amountMinor: 400 }] as never[],
    },
  ];
  const authorizeRefund = vi.fn(async () => {});
  await recordDeliveryCommand(db as never, scope, physicalReturn, { authorizeRefund });
  expect(authorizeRefund).not.toHaveBeenCalled();
  expect(refundPharmacyTender).not.toHaveBeenCalled();
});
it('DEV-647: keeps the PIN out of the replay fingerprint', async () => {
  const first = fixture();
  await recordDeliveryCommand(
    first.db as never,
    scope,
    { ...physicalReturn, managerPin: '7391' },
    { authorizeRefund: async () => {} }
  );
  const second = fixture();
  await recordDeliveryCommand(second.db as never, scope, physicalReturn, {
    authorizeRefund: async () => {},
  });
  const [withPin] = first.db.pharmacyOrderDeliveryEvidence.create.mock.calls[0]!;
  const [withoutPin] = second.db.pharmacyOrderDeliveryEvidence.create.mock.calls[0]!;
  expect(withPin.data.fingerprint).toBe(withoutPin.data.fingerprint);
  expect(JSON.stringify(withPin)).not.toContain('7391');
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
    expect.objectContaining({ type: 'CASH', amountMinor: 300, cashReceivedMinor: 300 }),
    undefined,
    // DEV-821: without a manager decision, the remit goes only into a till the actor runs.
    { drawerOperator: { kind: 'COUNTER', actorIsManager: false } }
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

function completedSaleFixture(returnedUnits = 0) {
  const fx = fixture();
  fx.sale.status = 'COMPLETED';
  fx.sale.tenders = [];
  fx.sale.lines = [
    {
      id: 'line-a',
      canonicalUnits: 10,
      allocations: [],
      returnLines: returnedUnits ? [{ canonicalUnits: returnedUnits }] : [],
    },
  ] as never[];
  return fx;
}
const completedReturn = { ...physicalReturn, quarantineLocationId: 'quarantine-a' };
it('DEV-786: refuses to return a completed sale without a refund authorizer', async () => {
  const { db } = completedSaleFixture();
  await expect(recordDeliveryCommand(db as never, scope, completedReturn)).rejects.toThrow(
    'REFUND_AUTHORIZATION_REQUIRED'
  );
  expect(returnSaleLine).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
  expect(db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
});
it('DEV-786: stops a completed-sale return when the manager PIN is refused', async () => {
  const { db } = completedSaleFixture();
  const authorizeRefund = vi.fn(async () => {
    throw new Error('Only a manager or owner can refund.');
  });
  await expect(
    recordDeliveryCommand(db as never, scope, completedReturn, { authorizeRefund })
  ).rejects.toThrow('Only a manager or owner can refund.');
  expect(authorizeRefund).toHaveBeenCalledOnce();
  expect(returnSaleLine).not.toHaveBeenCalled();
  expect(db.pharmacyOrderDeliveryEvidence.create).not.toHaveBeenCalled();
});
it('DEV-786: authorizes once before returning completed-sale lines to quarantine', async () => {
  const { db } = completedSaleFixture();
  const authorizeRefund = vi.fn(async () => {});
  await recordDeliveryCommand(db as never, scope, completedReturn, { authorizeRefund });
  expect(authorizeRefund).toHaveBeenCalledOnce();
  expect(returnSaleLine).toHaveBeenCalledWith(
    db,
    scope,
    expect.objectContaining({ saleLineId: 'line-a', canonicalUnits: 10, disposition: 'QUARANTINE' })
  );
  expect(authorizeRefund.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(returnSaleLine).mock.invocationCallOrder[0]
  );
});
it('DEV-786: needs no authorizer when every completed-sale line is already returned', async () => {
  const { db } = completedSaleFixture(10);
  await recordDeliveryCommand(db as never, scope, completedReturn);
  expect(returnSaleLine).not.toHaveBeenCalled();
  expect(db.pharmacyCustomerOrder.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { status: 'RETURNED' } })
  );
});
