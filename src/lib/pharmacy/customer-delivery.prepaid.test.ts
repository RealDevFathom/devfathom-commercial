import { beforeEach, expect, it, vi } from 'vitest';
import { recordDeliveryCommand } from './customer-delivery';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
vi.mock('./settlement', async () => ({
  ...(await vi.importActual<typeof import('./settlement')>('./settlement')),
  applyPharmacyTender: vi.fn(),
  refundPharmacyTender: vi.fn(),
}));
vi.mock('./sales', () => ({ changeSaleStatus: vi.fn(), returnSaleLine: vi.fn() }));
vi.mock('./inventory-operations', () => ({ quarantinePart: vi.fn() }));
vi.mock('./customer-ordering', () => ({ releaseOrderReservations: vi.fn() }));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'runner' };
function fixture(
  tenders: Array<Record<string, unknown>> = [],
  deliveryEvidence: Array<Record<string, unknown>> = []
) {
  const sale = {
    id: 'sale-a',
    organizationId: 'org-a',
    customerId: 'customer-a',
    status: 'OPEN',
    lines: [
      {
        id: 'line-a',
        createdAt: new Date('2026-11-17T08:00:00Z'),
        quantity: 1,
        unitPriceMinor: 1000,
        grossMinor: 1000,
        discountMinor: 0,
        tierDiscountMinor: 0,
        tierName: null,
        medicine: { rx: false, restricted: false, controlled: false },
        allocations: [
          {
            id: 'alloc-a',
            canonicalUnits: 1,
            grossMinor: 1000,
            discountMinor: 0,
            lot: { unitCostMinor: 500 },
          },
        ],
        returnLines: [],
      },
    ],
    tenders,
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
    deliveryEvidence,
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    pharmacyCustomerOrder: { findFirst: vi.fn().mockResolvedValue(order), update: vi.fn() },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue(sale) },
    // The linked customer holds a funded 2% tier.
    pharmacyCustomer: {
      findFirst: vi.fn().mockResolvedValue({
        prepaidAccount: {
          balanceMinor: 10000,
          tierName: 'Bronze',
          discountBasisPoints: 200,
          tierVersionId: 'tier-v1',
        },
      }),
    },
    pharmacyPrepaidTierVersion: { findFirst: vi.fn().mockResolvedValue({ actorId: 'owner-a' }) },
    // DEV-66: the owner's maximum discount at its stored default of 10%; no branch policy.
    organization: { findFirst: vi.fn().mockResolvedValue({ pharmacyMaxDiscountBps: 1_000 }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ discountPolicy: null }) },
    pharmacySaleLine: { update: vi.fn() },
    pharmacyStockMovement: { findFirst: vi.fn().mockResolvedValue({ stockLocationId: 'store' }) },
    pharmacyOrderDeliveryEvidence: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evidence-a',
        ...data,
      })),
    },
  };
  return { db, sale };
}
const collect = (amountMinor: number) => ({
  branchId: scope.branchId,
  orderId: 'order-a',
  action: 'COLLECT' as const,
  amountMinor,
  reference: 'cash-collected',
  requestKey: `collect-${amountMinor}`,
});
const refused = [{ action: 'REFUSED', amountMinor: null, requestKey: 'refuse-a' }];
beforeEach(() => vi.clearAllMocks());
it('DEV-863: a tier customer’s COD amount is the bill after their prepaid tier discount', async () => {
  const { db } = fixture();
  await expect(recordDeliveryCommand(db as never, scope, collect(1000))).rejects.toThrow(
    'INVALID_AMOUNT'
  );
  await expect(recordDeliveryCommand(db as never, scope, collect(980))).resolves.toMatchObject({
    replayed: false,
  });
  // The first collection freezes the discount on the bill under the customer lock.
  expect(db.pharmacySaleLine.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ tierDiscountMinor: 20 }) })
  );
});
it('DEV-863: after collection the remittance settles the frozen bill, whatever the tier does next', async () => {
  const { db, sale } = fixture(
    [],
    [{ action: 'COLLECT', amountMinor: 980, requestKey: 'collect-a' }]
  );
  // The collection froze 20 off the bill; the customer has since moved to a 5% tier.
  Object.assign(sale.lines[0]!, {
    discountMinor: 20,
    tierDiscountMinor: 20,
    tierName: 'Bronze',
    tierAllocationDiscounts: { 'alloc-a': 20 },
  });
  db.pharmacyCustomer.findFirst.mockResolvedValue({
    prepaidAccount: {
      balanceMinor: 50000,
      tierName: 'Gold',
      discountBasisPoints: 500,
      tierVersionId: 'tier-v2',
    },
  });
  await recordDeliveryCommand(
    db as never,
    { ...scope, actorId: 'cashier' },
    {
      branchId: scope.branchId,
      orderId: 'order-a',
      action: 'REMIT',
      amountMinor: 980,
      reference: 'cash-received',
      requestKey: 'remit-a',
      deviceId: 'device-a',
      businessDate: new Date('2026-11-17'),
    }
  );
  expect(db.pharmacySaleLine.update).not.toHaveBeenCalled();
  expect(applyPharmacyTender).toHaveBeenCalledWith(
    db,
    expect.anything(),
    expect.objectContaining({ type: 'CASH', amountMinor: 980 }),
    undefined,
    expect.objectContaining({ prepaidPricingFrozen: true })
  );
});
it('DEV-863: a failed delivery partly paid from a prepaid balance restores it before the void', async () => {
  const { db } = fixture(
    [
      {
        id: 'prepaid-a',
        type: 'WALLET',
        provider: 'CUSTOMER_PREPAID',
        amountMinor: 400,
        refunds: [],
        createdAt: new Date('2026-11-17T08:01:00Z'),
      },
    ],
    refused
  );
  await recordDeliveryCommand(
    db as never,
    { ...scope, actorId: 'cashier' },
    {
      branchId: scope.branchId,
      orderId: 'order-a',
      action: 'PHYSICAL_RETURN',
      reference: 'received',
      requestKey: 'return-a',
      deviceId: 'device-a',
      businessDate: new Date('2026-11-17'),
    },
    { authorizeRefund: async () => {} }
  );
  expect(refundPharmacyTender).toHaveBeenCalledWith(
    db,
    expect.anything(),
    expect.objectContaining({ originalTenderId: 'prepaid-a', amountMinor: 400 }),
    expect.anything()
  );
});
it('DEV-863: still refuses a failed delivery paid through an external wallet provider', async () => {
  const { db } = fixture(
    [
      {
        id: 'wallet-a',
        type: 'WALLET',
        provider: 'SOME_WALLET',
        amountMinor: 400,
        refunds: [],
        createdAt: new Date('2026-11-17T08:01:00Z'),
      },
    ],
    refused
  );
  await expect(
    recordDeliveryCommand(
      db as never,
      { ...scope, actorId: 'cashier' },
      {
        branchId: scope.branchId,
        orderId: 'order-a',
        action: 'PHYSICAL_RETURN',
        reference: 'received',
        requestKey: 'return-b',
        deviceId: 'device-a',
        businessDate: new Date('2026-11-17'),
      },
      { authorizeRefund: async () => {} }
    )
  ).rejects.toThrow('PAYMENT_RECONCILIATION_REQUIRED');
  expect(refundPharmacyTender).not.toHaveBeenCalled();
});
