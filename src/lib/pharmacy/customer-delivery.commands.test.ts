import { beforeEach, expect, it, vi } from 'vitest';
import { recordDeliveryCommand } from './customer-delivery';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
import { changeSaleStatus, returnSaleLine } from './sales';
import { quarantinePart } from './inventory-operations';
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
    // DEV-863: the bill was priced at collection, so the remittance never reprices it.
    { drawerOperator: { kind: 'COUNTER', actorIsManager: false }, prepaidPricingFrozen: true }
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

const balanceLock = (db: ReturnType<typeof fixture>['db']) => {
  const statements = db.$queryRaw.mock.calls.map(
    ([sql]) => sql as { strings?: string[]; values: unknown[] }
  );
  const index = statements.findIndex((sql) => sql.strings?.join('').includes('stock_lock:balance'));
  return { index, sql: statements[index] };
};

it('DEV-825: locks every returned balance, sorted, before the void and the quarantine', async () => {
  const { db, sale } = fixture();
  sale.tenders = [];
  sale.lines = [
    {
      allocations: [
        { id: 'alloc-b', inventoryLotId: 'lot-b', stockMovementId: 'move-b', canonicalUnits: 1 },
        { id: 'alloc-a', inventoryLotId: 'lot-a', stockMovementId: 'move-a', canonicalUnits: 1 },
      ],
    },
  ] as never[];
  Object.assign(db, {
    pharmacyStockMovement: { findFirst: vi.fn(async () => ({ stockLocationId: 'shelf' })) },
  });
  await recordDeliveryCommand(db as never, scope, physicalReturn, {
    authorizeRefund: async () => {},
  });
  const { index, sql } = balanceLock(db);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(sql!.values.slice(2)).toEqual([
    'lot-a',
    'shelf',
    'AVAILABLE',
    'lot-a',
    'shelf',
    'QUARANTINE',
    'lot-b',
    'shelf',
    'AVAILABLE',
    'lot-b',
    'shelf',
    'QUARANTINE',
  ]);
  const lockedAt = db.$queryRaw.mock.invocationCallOrder[index]!;
  expect(lockedAt).toBeLessThan(vi.mocked(changeSaleStatus).mock.invocationCallOrder[0]!);
  expect(lockedAt).toBeLessThan(vi.mocked(quarantinePart).mock.invocationCallOrder[0]!);
});

it('DEV-825: locks every reserved balance once, sorted, before quarantining an unsold order', async () => {
  const { db, order } = fixture();
  Object.assign(order, {
    counterSaleId: null,
    counterSale: null,
    deliveryEvidence: [{ action: 'REFUSED', amountMinor: null, requestKey: 'refuse-a' }],
  });
  Object.assign(db, {
    pharmacyRestockReservation: {
      findMany: vi.fn(async () => [
        { id: 'r-b', inventoryLotId: 'lot-b', stockLocationId: 'shelf', reservedUnits: 1 },
        { id: 'r-a', inventoryLotId: 'lot-a', stockLocationId: 'shelf', reservedUnits: 1 },
      ]),
    },
  });
  await recordDeliveryCommand(db as never, scope, physicalReturn);
  const { index, sql } = balanceLock(db);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(sql!.values.filter((value) => String(value).startsWith('lot-'))).toEqual([
    'lot-a',
    'lot-a',
    'lot-b',
    'lot-b',
  ]);
  expect(quarantinePart).toHaveBeenCalledTimes(2);
  expect(db.$queryRaw.mock.invocationCallOrder[index]!).toBeLessThan(
    vi.mocked(quarantinePart).mock.invocationCallOrder[0]!
  );
  // One sorted lock, not one per reservation.
  expect(
    db.$queryRaw.mock.calls.filter(([sql]) =>
      ((sql as { strings?: string[] }).strings?.join('') ?? '').includes('pharmacy_stock_balances')
    )
  ).toHaveLength(1);
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
it.each([
  // DEV-943: 19:30 UTC is already 00:30 the next day in Karachi; 18:59 UTC is still 23:59.
  ['Asia/Karachi', '2026-11-18T19:30:00.000Z', '2026-11-19'],
  ['Asia/Karachi', '2026-11-18T18:59:00.000Z', '2026-11-18'],
  // A UTC organisation books on the UTC day, as before.
  ['UTC', '2026-11-18T19:30:00.000Z', '2026-11-18'],
])(
  'DEV-943: a %s return refund at %s books on the shop day %s when no date is sent',
  async (timezone, now, day) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
    try {
      const { db } = fixture();
      const findUnique = vi.fn().mockResolvedValue({ timezone });
      const scoped = { ...db, organization: { findUnique } };
      const { businessDate: _omitted, ...withoutDate } = physicalReturn;
      void _omitted;
      await recordDeliveryCommand(scoped as never, scope, withoutDate, {
        authorizeRefund: async () => {},
      });
      // The zone is read from the caller's own organisation, never from input.
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: scope.organizationId },
        select: { timezone: true },
      });
      expect(refundPharmacyTender).toHaveBeenCalledWith(
        scoped,
        scope,
        expect.objectContaining({ businessDate: new Date(`${day}T00:00:00.000Z`) }),
        { drawerOperator: { kind: 'COUNTER', actorIsManager: true } }
      );
    } finally {
      vi.useRealTimers();
    }
  }
);
it('DEV-943: a return without a drawer device still asks for the drawer', async () => {
  const { db } = fixture();
  const { businessDate: _date, deviceId: _device, ...withoutDrawer } = physicalReturn;
  void _date;
  void _device;
  await expect(
    recordDeliveryCommand(db as never, scope, withoutDrawer, { authorizeRefund: async () => {} })
  ).rejects.toThrow('DRAWER_REQUIRED');
  expect(refundPharmacyTender).not.toHaveBeenCalled();
});
