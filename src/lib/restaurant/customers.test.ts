/**
 * M8 customer service against migrated PostgreSQL. Requires TEST_DATABASE_URL;
 * otherwise skipped. Uses one small tenant fixture plus a second tenant for the
 * identifier-isolation check.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha94_${suffix}`;
const otherOrgId = `org_wha94_other_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  staff: `staff_${suffix}`,
  device: `device_${suffix}`,
  openOrder: `order_open_${suffix}`,
  closedOrder: `order_closed_${suffix}`,
};
const t1 = new Date('2026-08-21T10:00:00.000Z');
const t2 = new Date('2026-08-21T11:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  customers: typeof import('./customers');
};

let deps: Deps;

function tenant<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, work);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, customers] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./customers'),
  ]);
  deps = { ...scopedDb, customers };

  await deps.withPlatformDb((tx) =>
    tx.organization.createMany({
      data: [
        {
          id: orgId,
          slug: `wha94-${suffix}`,
          legalName: 'Customer Test Co',
          displayName: 'Customer Test',
          status: 'ACTIVE',
        },
        {
          id: otherOrgId,
          slug: `wha94-other-${suffix}`,
          legalName: 'Other Customer Test Co',
          displayName: 'Other Customer Test',
          status: 'ACTIVE',
        },
      ],
    })
  );

  await tenant(async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.staff, displayName: 'Operator' },
    });
    await tx.restaurantRegisteredDevice.create({
      data: {
        id: ids.device,
        branchId: ids.branch,
        name: 'POS',
        deviceSecretHash: `hash_${suffix}`,
      },
    });
    const orderBase = {
      branchId: ids.branch,
      businessDate: new Date('2026-08-21T00:00:00.000Z'),
      channel: 'TAKEAWAY' as const,
      staffProfileId: ids.staff,
      deviceId: ids.device,
    };
    await tx.restaurantOrder.createMany({
      data: [
        { ...orderBase, id: ids.openOrder, orderNumber: 1, status: 'OPEN', openedAt: t1 },
        { ...orderBase, id: ids.closedOrder, orderNumber: 2, status: 'CLOSED', closedAt: t2 },
      ],
    });
  });
}, 60_000);

describeIfDatabase('M8 customer service (real PostgreSQL)', () => {
  it('normalizes email, rejects duplicates per tenant, and allows the same identifier cross-tenant', async () => {
    const first = await tenant((tx) =>
      deps.customers.createCustomer(tx, {
        displayName: 'Ada Lovelace',
        identifiers: [{ kind: 'EMAIL', value: '  ADA@Example.COM ' }],
      })
    );
    expect(first.identifiers[0]?.normalizedValue).toBe('ada@example.com');

    await expect(
      tenant((tx) =>
        deps.customers.createCustomer(tx, {
          identifiers: [{ kind: 'EMAIL', value: 'ADA@example.com' }],
        })
      )
    ).rejects.toMatchObject({ reason: 'DUPLICATE_IDENTIFIER' });

    const crossTenant = await deps.withTenantDb(otherOrgId, (tx) =>
      deps.customers.createCustomer(tx, {
        identifiers: [{ kind: 'EMAIL', value: 'ada@example.com' }],
      })
    );
    expect(crossTenant.identifiers[0]?.normalizedValue).toBe('ada@example.com');
  });

  it('rejects non-canonical phone identifiers', async () => {
    await expect(
      tenant((tx) =>
        deps.customers.createCustomer(tx, {
          identifiers: [{ kind: 'PHONE', value: '0300 1234567' }],
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_IDENTIFIER' });
  });

  it('returns tags, order/branch interaction refs, consent history/current state, and loyalty summary', async () => {
    const customer = await tenant((tx) =>
      deps.customers.createCustomer(tx, {
        displayName: 'Grace Hopper',
        identifiers: [{ kind: 'PHONE', value: '+12025550123' }],
      })
    );
    const tag = await tenant((tx) =>
      deps.customers.createCustomerTag(tx, { name: 'Regular', color: '#123456' })
    );
    await tenant((tx) =>
      deps.customers.assignCustomerTag(tx, { customerId: customer.id, tagId: tag.id })
    );
    await tenant((tx) =>
      deps.customers.attachCustomerToOrder(tx, { customerId: customer.id, orderId: ids.openOrder })
    );

    const interactionInput = {
      customerId: customer.id,
      branchId: ids.branch,
      orderId: ids.openOrder,
      type: 'ORDER_OPENED',
      idempotencyKey: `interaction_${suffix}`,
      occurredAt: t1,
    };
    const interaction = await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, interactionInput)
    );
    const interactionReplay = await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, interactionInput)
    );
    expect(interactionReplay.id).toBe(interaction.id);

    const consentBase = {
      customerId: customer.id,
      channel: 'EMAIL' as const,
      source: 'checkout',
      actorId: ids.staff,
      policyVersion: 'v1',
    };
    await tenant((tx) =>
      deps.customers.appendCustomerConsent(tx, {
        ...consentBase,
        granted: true,
        occurredAt: t1,
        idempotencyKey: `consent_1_${suffix}`,
      })
    );
    const latest = await tenant((tx) =>
      deps.customers.appendCustomerConsent(tx, {
        ...consentBase,
        granted: false,
        occurredAt: t2,
        idempotencyKey: `consent_2_${suffix}`,
      })
    );
    const replay = await tenant((tx) =>
      deps.customers.appendCustomerConsent(tx, {
        ...consentBase,
        granted: false,
        occurredAt: t2,
        idempotencyKey: `consent_2_${suffix}`,
      })
    );
    expect(replay.id).toBe(latest.id);

    await tenant(async (tx) => {
      const version = await tx.loyaltyProgramVersion.create({
        data: {
          versionNumber: 1,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          earnRate: '1',
          redemptionValue: '1',
        },
      });
      const account = await tx.loyaltyAccount.create({ data: { customerId: customer.id } });
      await tx.loyaltyPointsEntry.create({
        data: {
          accountId: account.id,
          programVersionId: version.id,
          kind: 'ADJUSTMENT',
          points: 25,
          actorId: ids.staff,
          reason: 'Opening balance',
          idempotencyKey: `points_${suffix}`,
        },
      });
    });

    const detail = await tenant((tx) => deps.customers.getCustomer(tx, customer.id));
    expect(detail.tags).toMatchObject([{ id: tag.id, name: 'Regular' }]);
    expect(detail.orders[0]).toMatchObject({ id: ids.openOrder, branch: { name: 'Main' } });
    expect(detail.interactions[0]).toMatchObject({
      id: interaction.id,
      branch: { id: ids.branch },
      order: { id: ids.openOrder },
    });
    expect(detail.consentEvents).toHaveLength(2);
    expect(detail.currentConsent.EMAIL).toMatchObject({ id: latest.id, granted: false });
    expect(detail.loyaltySummary).toMatchObject({ active: true, balance: 25 });

    for (let index = 0; index < 6; index += 1) {
      await tenant((tx) =>
        deps.customers.appendCustomerInteraction(tx, {
          customerId: customer.id,
          branchId: ids.branch,
          type: `VISIT_${index}`,
          idempotencyKey: `recent_interaction_${index}_${suffix}`,
          occurredAt: new Date(t2.getTime() + index + 1),
        })
      );
    }

    const page = await tenant((tx) =>
      deps.customers.listCustomers(tx, { query: 'grace', tagId: tag.id, limit: 1 })
    );
    expect(page.customers.map(({ id }) => id)).toEqual([customer.id]);
    expect(page.customers[0]?.interactions).toHaveLength(5);
    expect(page.customers[0]?.interactions[0]).toMatchObject({
      branch: { id: ids.branch, name: 'Main' },
      type: 'VISIT_5',
    });
    expect(page.customers[0]).not.toHaveProperty('orders');
    expect(page.customers[0]).not.toHaveProperty('consentEvents');
    expect(page.customers[0]).not.toHaveProperty('loyaltySummary');
    expect(page.customers[0]?.interactions[0]).not.toHaveProperty('payload');
  });

  it('atomically attaches only unassigned OPEN orders and preserves domain errors', async () => {
    const [customer, otherCustomer] = await Promise.all([
      tenant((tx) => deps.customers.createCustomer(tx, {})),
      tenant((tx) => deps.customers.createCustomer(tx, {})),
    ]);
    await expect(
      tenant((tx) =>
        deps.customers.attachCustomerToOrder(tx, {
          customerId: customer.id,
          orderId: ids.closedOrder,
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });

    const orderId = `order_attach_${suffix}`;
    await tenant((tx) =>
      tx.restaurantOrder.create({
        data: {
          id: orderId,
          branchId: ids.branch,
          orderNumber: 3,
          businessDate: new Date('2026-08-21T00:00:00.000Z'),
          status: 'OPEN',
          channel: 'TAKEAWAY',
          staffProfileId: ids.staff,
          deviceId: ids.device,
          openedAt: t1,
        },
      })
    );
    await expect(
      tenant((tx) => deps.customers.attachCustomerToOrder(tx, { customerId: customer.id, orderId }))
    ).resolves.toMatchObject({ customerId: customer.id, status: 'OPEN' });
    await expect(
      tenant((tx) =>
        deps.customers.attachCustomerToOrder(tx, { customerId: otherCustomer.id, orderId })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    await expect(
      tenant((tx) =>
        deps.customers.attachCustomerToOrder(tx, {
          customerId: customer.id,
          orderId: `missing_${suffix}`,
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('replays a consent key only for an identical event and never swallows an opt-out', async () => {
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const idempotencyKey = `consent_material_${suffix}`;
    const grant = {
      customerId: customer.id,
      channel: 'EMAIL' as const,
      granted: true,
      source: 'checkout',
      actorId: ids.staff,
      policyVersion: 'v1',
      occurredAt: t1,
      idempotencyKey,
    };
    const stored = await tenant((tx) => deps.customers.appendCustomerConsent(tx, grant));

    const replay = await tenant((tx) => deps.customers.appendCustomerConsent(tx, grant));
    expect(replay.id).toBe(stored.id);
    expect(await tenant((tx) => tx.customerConsent.count({ where: { idempotencyKey } }))).toBe(1);

    // Every material field, flipped one at a time. The opt-out case is the
    // privacy-critical one: it must conflict, not return the stored grant.
    for (const conflicting of [
      { ...grant, granted: false },
      { ...grant, source: 'call-center' },
      { ...grant, actorId: `${ids.staff}_other` },
      { ...grant, policyVersion: 'v2' },
      { ...grant, occurredAt: t2 },
    ]) {
      await expect(
        tenant((tx) => deps.customers.appendCustomerConsent(tx, conflicting))
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    }

    const after = await tenant(async (tx) => ({
      count: await tx.customerConsent.count({ where: { idempotencyKey } }),
      row: await tx.customerConsent.findUnique({ where: { id: stored.id } }),
    }));
    expect(after.count).toBe(1);
    expect(after.row).toMatchObject({ granted: true, source: 'checkout', policyVersion: 'v1' });

    // A distinct key still records the opt-out, so the conflict is not a dead end.
    const optOut = await tenant((tx) =>
      deps.customers.appendCustomerConsent(tx, {
        ...grant,
        granted: false,
        occurredAt: t2,
        idempotencyKey: `${idempotencyKey}_optout`,
      })
    );
    const detail = await tenant((tx) => deps.customers.getCustomer(tx, customer.id));
    expect(detail.currentConsent.EMAIL).toMatchObject({ id: optOut.id, granted: false });
  });

  it('replays an interaction key only for the same material event', async () => {
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const idempotencyKey = `interaction_material_${suffix}`;
    const base = {
      customerId: customer.id,
      branchId: ids.branch,
      type: 'FEEDBACK',
      occurredAt: t1,
      idempotencyKey,
    };
    const stored = await tenant((tx) => deps.customers.appendCustomerInteraction(tx, base));

    const replay = await tenant((tx) => deps.customers.appendCustomerInteraction(tx, base));
    expect(replay.id).toBe(stored.id);
    expect(await tenant((tx) => tx.customerInteraction.count({ where: { idempotencyKey } }))).toBe(
      1
    );

    // The comparison uses the normalized type, so surrounding whitespace names
    // the same event rather than a spurious conflict.
    const padded = await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, { ...base, type: '  FEEDBACK  ' })
    );
    expect(padded.id).toBe(stored.id);

    const otherCustomer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const otherBranch = await tenant((tx) =>
      tx.restaurantBranch.create({
        data: { name: 'Annex', timezone: 'UTC', businessDayCutoff: '00:00' },
      })
    );

    // Every field this API accepts, flipped one at a time. A reused key that
    // names a different event must conflict, never hand back the stored row.
    for (const conflicting of [
      { ...base, customerId: otherCustomer.id },
      { ...base, branchId: otherBranch.id },
      { ...base, orderId: ids.openOrder },
      { ...base, type: 'COMPLAINT' },
      { ...base, occurredAt: t2 },
    ]) {
      await expect(
        tenant((tx) => deps.customers.appendCustomerInteraction(tx, conflicting))
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    }

    const after = await tenant(async (tx) => ({
      count: await tx.customerInteraction.count({ where: { idempotencyKey } }),
      row: await tx.customerInteraction.findUnique({ where: { id: stored.id } }),
    }));
    expect(after.count).toBe(1);
    expect(after.row).toMatchObject({
      customerId: customer.id,
      branchId: ids.branch,
      orderId: null,
      type: 'FEEDBACK',
    });
    expect(after.row?.occurredAt.getTime()).toBe(t1.getTime());
  });

  it('writes no interaction payload and offers no way to supply one', async () => {
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const idempotencyKey = `interaction_no_payload_${suffix}`;
    const base = {
      customerId: customer.id,
      branchId: ids.branch,
      type: 'NOTE',
      occurredAt: t1,
      idempotencyKey,
    };

    // The `payload` column has no export, anonymization or redaction path, so
    // this service leaves it at the empty-object column default.
    const stored = await tenant((tx) => deps.customers.appendCustomerInteraction(tx, base));
    const row = await tenant((tx) =>
      tx.customerInteraction.findUnique({ where: { id: stored.id } })
    );
    expect(row?.payload).toEqual({});

    // The write surface rejects a payload at the type level, and a value
    // smuggled past it is dropped rather than persisted.
    const smuggled = await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, {
        ...base,
        idempotencyKey: `${idempotencyKey}_surplus`,
        // @ts-expect-error — payload is not part of the interaction write surface
        payload: { note: 'must never be written' },
      })
    );
    const smuggledRow = await tenant((tx) =>
      tx.customerInteraction.findUnique({ where: { id: smuggled.id } })
    );
    expect(smuggledRow?.payload).toEqual({});
  });

  it('replays a server-assigned occurredAt without holding the caller to the server clock', async () => {
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const idempotencyKey = `interaction_clock_${suffix}`;
    const base = {
      customerId: customer.id,
      branchId: ids.branch,
      type: 'VISIT',
      idempotencyKey,
    };
    const stored = await tenant((tx) => deps.customers.appendCustomerInteraction(tx, base));
    const replay = await tenant((tx) => deps.customers.appendCustomerInteraction(tx, base));
    expect(replay.id).toBe(stored.id);
    expect(replay.occurredAt.getTime()).toBe(stored.occurredAt.getTime());

    // Naming an instant that is not the stored one is still a conflict.
    await expect(
      tenant((tx) => deps.customers.appendCustomerInteraction(tx, { ...base, occurredAt: t1 }))
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(await tenant((tx) => tx.customerInteraction.count({ where: { idempotencyKey } }))).toBe(
      1
    );
  });

  it('keeps idempotency-key comparison tenant-scoped', async () => {
    const idempotencyKey = `interaction_cross_tenant_${suffix}`;
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, {
        customerId: customer.id,
        branchId: ids.branch,
        type: 'VISIT',
        occurredAt: t1,
        idempotencyKey,
      })
    );

    // The other tenant's row is invisible, so the same key is free there and the
    // first tenant's ledger is untouched.
    const otherRow = await deps.withTenantDb(otherOrgId, async (tx) => {
      const branch = await tx.restaurantBranch.create({
        data: { name: 'Other Main', timezone: 'UTC', businessDayCutoff: '00:00' },
      });
      const otherCustomer = await deps.customers.createCustomer(tx, {});
      return deps.customers.appendCustomerInteraction(tx, {
        customerId: otherCustomer.id,
        branchId: branch.id,
        type: 'COMPLAINT',
        occurredAt: t2,
        idempotencyKey,
      });
    });

    const mine = await tenant((tx) =>
      tx.customerInteraction.findMany({ where: { idempotencyKey } })
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.type).toBe('VISIT');
    expect(mine[0]?.id).not.toBe(otherRow.id);
  });

  it('maps normalized duplicate tag names to a domain conflict', async () => {
    await tenant((tx) => deps.customers.createCustomerTag(tx, { name: `Loyal ${suffix}` }));
    await expect(
      tenant((tx) => deps.customers.createCustomerTag(tx, { name: `  loyal ${suffix}  ` }))
    ).rejects.toMatchObject({ reason: 'DUPLICATE_TAG' });
  });

  it('rejects unprivileged UPDATE and DELETE of consent and interaction ledgers', async () => {
    const customer = await tenant((tx) => deps.customers.createCustomer(tx, {}));
    const interaction = await tenant((tx) =>
      deps.customers.appendCustomerInteraction(tx, {
        customerId: customer.id,
        branchId: ids.branch,
        type: 'NOTE',
        idempotencyKey: `locked_interaction_${suffix}`,
      })
    );
    const consent = await tenant((tx) =>
      deps.customers.appendCustomerConsent(tx, {
        customerId: customer.id,
        channel: 'SMS',
        granted: true,
        source: 'profile',
        actorId: ids.staff,
        policyVersion: 'v1',
        idempotencyKey: `locked_consent_${suffix}`,
      })
    );

    await expect(
      tenant((tx) =>
        tx.customerInteraction.update({ where: { id: interaction.id }, data: { type: 'CHANGED' } })
      )
    ).rejects.toBeDefined();
    await expect(
      tenant((tx) => tx.customerInteraction.delete({ where: { id: interaction.id } }))
    ).rejects.toBeDefined();
    await expect(
      tenant((tx) =>
        tx.customerConsent.update({ where: { id: consent.id }, data: { granted: false } })
      )
    ).rejects.toBeDefined();
    await expect(
      tenant((tx) => tx.customerConsent.delete({ where: { id: consent.id } }))
    ).rejects.toBeDefined();

    const unchanged = await tenant(async (tx) => ({
      interaction: await tx.customerInteraction.findUnique({ where: { id: interaction.id } }),
      consent: await tx.customerConsent.findUnique({ where: { id: consent.id } }),
    }));
    expect(unchanged.interaction?.type).toBe('NOTE');
    expect(unchanged.consent?.granted).toBe(true);
  });
});
