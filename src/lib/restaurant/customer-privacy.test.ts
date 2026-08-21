import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha94_privacy_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  staff: `staff_${suffix}`,
  device: `device_${suffix}`,
  order: `order_${suffix}`,
  bill: `bill_${suffix}`,
};
const occurredAt = new Date('2026-08-21T10:00:00.000Z');
const anonymizedAt = new Date('2026-08-21T12:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  customers: typeof import('./customers');
  privacy: typeof import('./customer-privacy');
};

let deps: Deps;
let targetId: string;
let otherId: string;
let consentId: string;
let ledgerId: string;

function tenant<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, work);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, customers, privacy] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./customers'),
    import('./customer-privacy'),
  ]);
  deps = { ...scopedDb, customers, privacy };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha94-privacy-${suffix}`,
        legalName: 'Customer Privacy Test Co',
        displayName: 'Customer Privacy Test',
        status: 'ACTIVE',
      },
    })
  );

  await tenant(async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({ data: { id: ids.staff, displayName: 'Operator' } });
    await tx.restaurantRegisteredDevice.create({
      data: {
        id: ids.device,
        branchId: ids.branch,
        name: 'POS',
        deviceSecretHash: `hash_${suffix}`,
      },
    });
  });

  const target = await tenant((tx) =>
    deps.customers.createCustomer(tx, {
      displayName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      birthDate: new Date('1815-12-10T00:00:00.000Z'),
      notes: 'Private note',
      identifiers: [{ kind: 'EMAIL', value: `ada.${suffix}@example.com` }],
    })
  );
  const other = await tenant((tx) =>
    deps.customers.createCustomer(tx, {
      displayName: 'Other Customer',
      identifiers: [{ kind: 'EMAIL', value: `other.${suffix}@example.com` }],
    })
  );
  targetId = target.id;
  otherId = other.id;

  await tenant(async (tx) => {
    const tag = await tx.customerTag.create({ data: { name: `VIP ${suffix}` } });
    await tx.customerTagAssignment.create({ data: { customerId: targetId, tagId: tag.id } });
    await tx.restaurantOrder.create({
      data: {
        id: ids.order,
        branchId: ids.branch,
        orderNumber: 1,
        businessDate: new Date('2026-08-21T00:00:00.000Z'),
        status: 'CLOSED',
        channel: 'TAKEAWAY',
        staffProfileId: ids.staff,
        deviceId: ids.device,
        customerId: targetId,
        closedAt: occurredAt,
      },
    });
    await tx.restaurantBill.create({
      data: {
        id: ids.bill,
        orderId: ids.order,
        branchId: ids.branch,
        businessDate: new Date('2026-08-21T00:00:00.000Z'),
        status: 'SETTLED',
        subtotal: '12.34',
        taxTotal: '1.23',
        grandTotal: '13.57',
        settledAt: occurredAt,
        openerStaffProfileId: ids.staff,
        deviceId: ids.device,
      },
    });
    await tx.customerInteraction.create({
      data: {
        customerId: targetId,
        branchId: ids.branch,
        orderId: ids.order,
        type: 'ORDER_CLOSED',
        occurredAt,
        idempotencyKey: `interaction_${suffix}`,
      },
    });
    const consent = await tx.customerConsent.create({
      data: {
        customerId: targetId,
        channel: 'EMAIL',
        granted: true,
        source: 'checkout',
        actorId: ids.staff,
        policyVersion: 'v1',
        occurredAt,
        idempotencyKey: `consent_${suffix}`,
      },
    });
    consentId = consent.id;
    const version = await tx.loyaltyProgramVersion.create({
      data: {
        versionNumber: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        earnRate: '1.250000',
        redemptionValue: '0.050000',
      },
    });
    const account = await tx.loyaltyAccount.create({ data: { customerId: targetId } });
    const ledger = await tx.loyaltyPointsEntry.create({
      data: {
        accountId: account.id,
        programVersionId: version.id,
        kind: 'EARN',
        points: 25,
        billId: ids.bill,
        idempotencyKey: `points_${suffix}`,
      },
    });
    ledgerId = ledger.id;
  });
}, 60_000);

describeIfDatabase('customer privacy (real PostgreSQL)', () => {
  it('exports only the requested customer and renders every Decimal as a string', async () => {
    const exported = await tenant((tx) => deps.privacy.exportCustomerData(tx, targetId));

    expect(exported.profile).toMatchObject({ id: targetId, displayName: 'Ada Lovelace' });
    expect(JSON.stringify(exported)).not.toContain(otherId);
    expect(exported.identifiers).toHaveLength(1);
    expect(exported.interactions).toHaveLength(1);
    expect(exported.tags).toHaveLength(1);
    expect(exported.tagAssignments).toHaveLength(1);
    expect(exported.consentEvents.map(({ id }) => id)).toEqual([consentId]);
    expect(exported.loyaltyLedger.map(({ id }) => id)).toEqual([ledgerId]);
    expect(exported.loyaltyProgramVersions[0]).toMatchObject({
      earnRate: '1.25',
      redemptionValue: '0.05',
    });
    expect(exported.orders.map(({ id }) => id)).toEqual([ids.order]);
    expect(exported.bills).toMatchObject([
      { id: ids.bill, subtotal: '12.34', taxTotal: '1.23', grandTotal: '13.57' },
    ]);
    expect(exported.profile.createdAt).toBeInstanceOf(Date);
  });

  it('anonymizes once while preserving retained history and financial records', async () => {
    const before = await tenant(async (tx) => ({
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: ids.order } }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: ids.bill } }),
      interaction: await tx.customerInteraction.findFirstOrThrow({ where: { customerId: targetId } }),
      consent: await tx.customerConsent.findUniqueOrThrow({ where: { id: consentId } }),
      ledger: await tx.loyaltyPointsEntry.findUniqueOrThrow({ where: { id: ledgerId } }),
      program: await tx.loyaltyProgramVersion.findFirstOrThrow({ where: { versionNumber: 1 } }),
    }));

    const first = await tenant((tx) =>
      deps.privacy.anonymizeCustomer(tx, { customerId: targetId, at: anonymizedAt })
    );
    const second = await tenant((tx) =>
      deps.privacy.anonymizeCustomer(tx, {
        customerId: targetId,
        at: new Date('2026-08-22T00:00:00.000Z'),
      })
    );

    expect(first).toEqual({ customerId: targetId, anonymizedAt });
    expect(second).toEqual(first);
    const after = await tenant(async (tx) => ({
      customer: await tx.restaurantCustomer.findUniqueOrThrow({ where: { id: targetId } }),
      identifiers: await tx.customerIdentifier.findMany({ where: { customerId: targetId } }),
      assignments: await tx.customerTagAssignment.findMany({ where: { customerId: targetId } }),
      loyalty: await tx.loyaltyAccount.findUniqueOrThrow({ where: { customerId: targetId } }),
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: ids.order } }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: ids.bill } }),
      interaction: await tx.customerInteraction.findFirstOrThrow({ where: { customerId: targetId } }),
      consent: await tx.customerConsent.findUniqueOrThrow({ where: { id: consentId } }),
      ledger: await tx.loyaltyPointsEntry.findUniqueOrThrow({ where: { id: ledgerId } }),
      program: await tx.loyaltyProgramVersion.findFirstOrThrow({ where: { versionNumber: 1 } }),
    }));

    expect(after.customer).toMatchObject({
      displayName: null,
      givenName: null,
      familyName: null,
      birthDate: null,
      notes: null,
      anonymizedAt,
    });
    expect(after.identifiers).toEqual([]);
    expect(after.assignments).toEqual([]);
    expect(after.loyalty).toMatchObject({ active: false, deactivatedAt: anonymizedAt });
    expect(after.order).toEqual(before.order);
    expect(after.bill).toEqual(before.bill);
    expect(after.interaction).toEqual(before.interaction);
    expect(after.consent).toEqual(before.consent);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.program).toEqual(before.program);
  });
});
