import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  platform: null as unknown,
  tenant: null as unknown,
  module: true,
}));

vi.mock('./customer-ordering', () => ({ placeCustomerOrder: vi.fn() }));
vi.mock('./rx-sale-gate', () => ({
  assertRxSaleAllowed: vi.fn().mockResolvedValue(undefined),
  PharmacyRxSaleDenied: class PharmacyRxSaleDenied extends Error {},
}));
vi.mock('@/lib/abac', () => ({ can: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => fake.module,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) => run(fake.platform),
  withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) => run(fake.tenant),
}));

import { placeCustomerOrder } from './customer-ordering';
import { assertRxSaleAllowed, PharmacyRxSaleDenied } from './rx-sale-gate';
import {
  chronicRefillReminderText,
  ChronicRefillError,
  createChronicRefillSubscription,
  createDueChronicRefillOrder,
  processDueChronicRefills,
  updateChronicRefillSubscription,
} from './chronic-refills';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1' };
const subscription = {
  id: 'subscription-1',
  customerId: 'customer-1',
  fulfillment: 'COLLECT' as const,
  paymentMode: 'KHATA' as const,
  addressLine: null,
  city: null,
  deliveryInstructions: null,
  cadenceDays: 30,
  nextDueAt: new Date('2026-10-29T00:00:00.000Z'),
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  quantityPacks: 1,
  prescriptionLineId: 'rx-line-1',
  rx: true,
};

function db(rows: unknown[][]) {
  return {
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

function sqlText(value: unknown) {
  return (value as { strings: string[] }).strings.join('?');
}

function sqlValues(value: unknown) {
  return (value as { values: unknown[] }).values;
}

const DAY = 86_400_000;
const allowance = (overrides: Record<string, number> = {}) => ({
  authorizedCanonicalUnits: 100,
  authorizedRepeats: 10,
  filledUnits: 0,
  fillCount: 0,
  pendingUnits: 0,
  pendingCount: 0,
  ...overrides,
});
const currentRow = {
  id: subscription.id,
  active: true,
  cancelledAt: null,
  cadenceDays: 30,
  nextDueAt: subscription.nextDueAt,
  quantityPacks: 1,
  fulfillment: 'COLLECT' as const,
  paymentMode: 'KHATA' as const,
  addressLine: null,
  city: null,
  deliveryInstructions: null,
};

describe('chronic refill cycles', () => {
  it('uses neutral utility copy with no API capable of receiving clinical names', () => {
    expect(
      chronicRefillReminderText({
        pharmacyName: 'Community Pharmacy',
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        fulfillment: 'COLLECT',
      })
    ).toBe(
      'Community Pharmacy: your monthly order is scheduled for collection on 2026-11-01. Reply YES to confirm or call us to make a change.'
    );
  });

  it('requires a fresh signed pharmacist decision for every Rx cycle', async () => {
    const database = db([[subscription]]);
    await expect(
      createDueChronicRefillOrder(database as never, scope, {
        subscriptionId: subscription.id,
        now: subscription.nextDueAt,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChronicRefillError>>({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      })
    );
    expect(placeCustomerOrder).not.toHaveBeenCalled();
  });

  it('rejects an Rx subscription when the prescription does not match the customer and item', async () => {
    const database = db([[]]);
    await expect(
      createChronicRefillSubscription(database as never, scope, {
        customerId: 'customer-1',
        medicineId: 'medicine-2',
        presentationId: 'presentation-2',
        packLevelId: 'pack-2',
        quantityPacks: 1,
        prescriptionLineId: 'rx-line-1',
        fulfillment: 'COLLECT',
        paymentMode: 'PREPAY',
        cadenceDays: 30,
        nextDueAt: subscription.nextDueAt,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChronicRefillError>>({ reason: 'SUBSCRIPTION_ITEM_INVALID' })
    );
    const query = sqlText(database.$queryRaw.mock.calls[0]?.[0]);
    expect(query).toContain('prescription."patientId" = customer."patientId"');
    expect(query).toContain('rx_line."medicineId" = medicine."id"');
    expect(query).toContain('rx_line."presentationId" = presentation."id"');
  });

  it('creates a Khata due order that reserves the monthly pack and records its cycle', async () => {
    const database = db([
      [subscription],
      [],
      [{ id: 'approval-1', canonicalUnits: 10 }],
      [allowance()],
    ]);
    vi.mocked(placeCustomerOrder).mockResolvedValueOnce({ id: 'order-1' } as never);
    const result = await createDueChronicRefillOrder(database as never, scope, {
      subscriptionId: subscription.id,
      pharmacistDecisionId: 'approval-1',
      now: subscription.nextDueAt,
    });
    expect(placeCustomerOrder).toHaveBeenCalledWith(
      database,
      scope,
      expect.objectContaining({
        customerId: 'customer-1',
        intendedPaymentMethod: 'CREDIT',
        reviewedRx: true,
        // Held through the due date plus grace, not the 30-minute storefront default.
        reservationExpiresAt: new Date('2026-10-31T00:00:00.000Z'),
        lines: [expect.objectContaining({ packLevelId: 'pack-1', quantity: 1 })],
      })
    );
    expect(database.$executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(database.$queryRaw.mock.calls[1]?.[0])).toContain(
      'FROM "pharmacy_prescription_lines"'
    );
    expect(sqlText(database.$queryRaw.mock.calls[1]?.[0])).toContain('FOR UPDATE');
    const approvalQuery = sqlText(database.$queryRaw.mock.calls[2]?.[0]);
    expect(approvalQuery).toContain('JOIN "pharmacy_chronic_refill_subscriptions" subscription');
    expect(approvalQuery).toContain('sale_line."medicineId" = subscription."medicineId"');
    expect(approvalQuery).toContain('sale_line."presentationId" = subscription."presentationId"');
    expect(approvalQuery).toContain('sale_line."quantity" = subscription."quantityPacks"');
    // Bound to this cycle: signed after the subscription/previous cycle, on a sale that never
    // completed or filled, and locked so that sale cannot complete concurrently.
    expect(approvalQuery).toContain('decision."createdAt" >= COALESCE(');
    expect(approvalQuery).toContain(`sale."status" <> 'COMPLETED'`);
    expect(approvalQuery).toContain('"pharmacy_prescription_fills" fill');
    expect(approvalQuery).toContain('FOR UPDATE OF sale');
    const allowanceQuery = sqlText(database.$queryRaw.mock.calls[3]?.[0]);
    expect(allowanceQuery).toContain('customer."id" =');
    expect(allowanceQuery).toContain('"pendingUnits"');
    expect(sqlValues(database.$executeRaw.mock.calls[0]?.[0])).toContain('approval-1');
    expect(result).toEqual({
      order: { id: 'order-1' },
      nextDueAt: new Date('2026-11-28T00:00:00.000Z'),
    });
  });

  it.each([
    ['units would exceed the authorised quantity', allowance({ filledUnits: 85, pendingUnits: 10 })],
    ['repeats are used up', allowance({ fillCount: 9, pendingCount: 2 })],
  ])('refuses an Rx cycle when %s', async (_label, remaining) => {
    const before = vi.mocked(placeCustomerOrder).mock.calls.length;
    const database = db([
      [subscription],
      [],
      [{ id: 'approval-1', canonicalUnits: 10 }],
      [remaining],
    ]);
    await expect(
      createDueChronicRefillOrder(database as never, scope, {
        subscriptionId: subscription.id,
        pharmacistDecisionId: 'approval-1',
        now: subscription.nextDueAt,
      })
    ).rejects.toMatchObject({ reason: 'PRESCRIPTION_EXHAUSTED' });
    expect(vi.mocked(placeCustomerOrder).mock.calls.length).toBe(before);
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses to release an Rx cycle for a user without the dispense grant', async () => {
    vi.mocked(assertRxSaleAllowed).mockRejectedValueOnce(new PharmacyRxSaleDenied());
    const database = db([[subscription]]);
    await expect(
      createDueChronicRefillOrder(database as never, scope, {
        subscriptionId: subscription.id,
        pharmacistDecisionId: 'approval-1',
        now: subscription.nextDueAt,
      })
    ).rejects.toMatchObject({ reason: 'DISPENSE_PERMISSION_REQUIRED' });
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('prepares a cycle inside the lead window but not earlier', async () => {
    const otc = { ...subscription, rx: false, prescriptionLineId: null };
    const now = new Date(subscription.nextDueAt.getTime() - 3 * DAY);
    await expect(
      createDueChronicRefillOrder(db([[otc]]) as never, scope, {
        subscriptionId: otc.id,
        now,
      })
    ).rejects.toMatchObject({ reason: 'NOT_DUE' });
    vi.mocked(placeCustomerOrder).mockResolvedValueOnce({ id: 'order-2' } as never);
    const early = new Date(subscription.nextDueAt.getTime() - DAY);
    await createDueChronicRefillOrder(db([[otc]]) as never, scope, {
      subscriptionId: otc.id,
      now: early,
    });
    expect(placeCustomerOrder).toHaveBeenLastCalledWith(
      expect.anything(),
      scope,
      expect.objectContaining({
        reservationExpiresAt: new Date(subscription.nextDueAt.getTime() + 2 * DAY),
      })
    );
  });

  it('moves a long-overdue subscription past now instead of back-filling every missed cycle', async () => {
    const overdue = {
      ...subscription,
      rx: false,
      prescriptionLineId: null,
      nextDueAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    vi.mocked(placeCustomerOrder).mockResolvedValueOnce({ id: 'order-3' } as never);
    const now = new Date('2026-10-29T00:00:00.000Z');
    const result = await createDueChronicRefillOrder(db([[overdue]]) as never, scope, {
      subscriptionId: overdue.id,
      now,
    });
    expect(result.nextDueAt.getTime()).toBeGreaterThan(now.getTime());
    expect(result.nextDueAt.getTime()).toBeLessThanOrEqual(now.getTime() + 30 * DAY);
  });

  it('rejects inconsistent fulfillment details as a domain error before touching the table', async () => {
    const database = db([[currentRow]]);
    await expect(
      updateChronicRefillSubscription(database as never, scope, {
        subscriptionId: subscription.id,
        fulfillment: 'DELIVER',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_FULFILLMENT' });
    expect(database.$executeRaw).not.toHaveBeenCalled();
    const createDb = db([]);
    await expect(
      createChronicRefillSubscription(createDb as never, scope, {
        customerId: 'customer-1',
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        packLevelId: 'pack-1',
        quantityPacks: 1,
        fulfillment: 'COLLECT',
        paymentMode: 'PREPAY',
        addressLine: '1 Test',
        cadenceDays: 30,
        nextDueAt: subscription.nextDueAt,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_FULFILLMENT' });
    expect(createDb.$queryRaw).not.toHaveBeenCalled();
  });

  it('records delivery-address changes in the immutable edit event', async () => {
    const database = db([[currentRow]]);
    await updateChronicRefillSubscription(database as never, scope, {
      subscriptionId: subscription.id,
      fulfillment: 'DELIVER',
      addressLine: '2 New Road',
      city: 'Lahore',
      deliveryInstructions: 'Ring twice',
    });
    const details = JSON.parse(
      sqlValues(database.$executeRaw.mock.calls[1]?.[0]).find(
        (value) => typeof value === 'string' && value.startsWith('{')
      ) as string
    );
    expect(details.changes).toMatchObject({
      fulfillment: { from: 'COLLECT', to: 'DELIVER' },
      addressLine: { from: null, to: '2 New Road' },
      city: { from: null, to: 'Lahore' },
      deliveryInstructions: { from: null, to: 'Ring twice' },
    });
  });

  it('resumes a long-paused subscription with one cycle due now', async () => {
    const now = new Date('2027-05-01T00:00:00.000Z');
    const database = db([[{ ...currentRow, active: false }]]);
    await updateChronicRefillSubscription(
      database as never,
      scope,
      { subscriptionId: subscription.id, action: 'REACTIVATE' },
      now
    );
    expect(sqlValues(database.$executeRaw.mock.calls[0]?.[0])).toContainEqual(now);
  });

  it('records an immutable lifecycle event when a subscription is paused', async () => {
    const database = db([[currentRow]]);
    await expect(
      updateChronicRefillSubscription(database as never, scope, {
        subscriptionId: subscription.id,
        action: 'PAUSE',
      })
    ).resolves.toMatchObject({ id: subscription.id, active: false });
    expect(database.$executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(database.$executeRaw.mock.calls[1]?.[0])).toContain(
      'pharmacy_chronic_refill_events'
    );
  });
});

describe('chronic refill scheduler', () => {
  const candidate = {
    id: 'subscription-9',
    organizationId: 'org-1',
    branchId: 'branch-1',
    createdByUserId: 'owner-1',
  };

  function tenantDb(organizationStatus: string, rows: unknown[][]) {
    const tenant = {
      ...db(rows),
      organization: {
        findUnique: vi.fn().mockResolvedValue({ vertical: 'PHARMACY', status: organizationStatus }),
      },
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
      user: { findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      $transaction: vi.fn(),
    };
    tenant.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(tenant));
    return tenant;
  }

  it('skips suspended tenants, defers them and records why', async () => {
    const before = vi.mocked(placeCustomerOrder).mock.calls.length;
    fake.platform = db([[candidate]]);
    const tenant = tenantDb('SUSPENDED', [[{ schedulerFailure: null }]]);
    fake.tenant = tenant;
    await expect(processDueChronicRefills({ now: subscription.nextDueAt })).resolves.toMatchObject(
      { scanned: 1, created: 0, skipped: 1, failed: 0 }
    );
    expect(vi.mocked(placeCustomerOrder).mock.calls.length).toBe(before);
    expect(sqlText((fake.platform as ReturnType<typeof db>).$queryRaw.mock.calls[0]?.[0])).toContain(
      '"schedulerRetryAt"'
    );
    expect(sqlText(tenant.$executeRaw.mock.calls[0]?.[0])).toContain('"schedulerRetryAt" =');
    expect(sqlValues(tenant.$executeRaw.mock.calls[0]?.[0])).toContain('TENANT_INACTIVE');
    expect(sqlText(tenant.$executeRaw.mock.calls[1]?.[0])).toContain('SCHEDULER_FAILED');
  });

  it('logs and defers a failing cycle so it cannot block the queue', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.platform = db([[candidate]]);
    const otc = { ...subscription, id: candidate.id, rx: false, prescriptionLineId: null };
    const tenant = tenantDb('ACTIVE', [[otc], [{ schedulerFailure: 'INSUFFICIENT_STOCK' }]]);
    fake.tenant = tenant;
    vi.mocked(placeCustomerOrder).mockRejectedValueOnce(
      Object.assign(new Error('out'), { reason: 'INSUFFICIENT_STOCK' })
    );
    await expect(processDueChronicRefills({ now: subscription.nextDueAt })).resolves.toMatchObject(
      { scanned: 1, created: 0, failed: 1 }
    );
    expect(error).toHaveBeenCalledWith(
      '[chronic-refills] automatic cycle failed',
      expect.objectContaining({ subscriptionId: candidate.id, reason: 'INSUFFICIENT_STOCK' })
    );
    expect(sqlValues(tenant.$executeRaw.mock.calls[0]?.[0])).toContain('INSUFFICIENT_STOCK');
    // Same failure as last time: deferred again without a duplicate event.
    expect(tenant.$executeRaw).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
