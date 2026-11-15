/**
 * M5-L4 payment adapter (C6).
 *
 *   1. PURE conformance suite over the MOCK provider — the registry contains
 *      exactly MOCK; every one of the six capabilities executes; approved status
 *      mapping; deterministic references; scriptable declines via designated
 *      decline amounts; prior-reference enforcement; unsupported-capability guard.
 *   2. DB-backed append-only event trail (requires TEST_DATABASE_URL) — a written
 *      event round-trips, and the PAN/CVV/track/PIN payload guard rejects card data
 *      before it reaches the table.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  MOCK_PROVIDER,
  PAYMENT_CAPABILITIES,
  PaymentAdapterError,
  REGISTERED_PROVIDERS,
  appendPaymentEvent,
  getPaymentProvider,
  type PaymentCapability,
} from './payment-adapter';

// ── Pure conformance (no database) ────────────────────────────────────────────

describe('provider registry (C6 — exactly MOCK)', () => {
  it('registers exactly the MOCK provider', () => {
    expect([...REGISTERED_PROVIDERS]).toEqual(['MOCK']);
    expect(getPaymentProvider('MOCK')).toBe(MOCK_PROVIDER);
  });

  it('throws on an unknown provider', () => {
    // @ts-expect-error — an unregistered provider must fail closed, not resolve
    expect(() => getPaymentProvider('STRIPE')).toThrowError(PaymentAdapterError);
  });

  it('declares all six capabilities', () => {
    expect([...MOCK_PROVIDER.capabilities].sort()).toEqual(
      ['ADJUST', 'AUTH', 'CAPTURE', 'REFUND', 'SALE', 'VOID'].sort()
    );
    for (const capability of PAYMENT_CAPABILITIES) {
      expect(MOCK_PROVIDER.supports(capability)).toBe(true);
    }
  });
});

describe('MOCK conformance — all six capabilities', () => {
  const priorRef = 'mock_auth_prior0000000000000000';

  const cases: Array<{ capability: PaymentCapability; status: string; needsPrior: boolean }> = [
    { capability: 'SALE', status: 'CAPTURED', needsPrior: false },
    { capability: 'AUTH', status: 'AUTHORIZED', needsPrior: false },
    { capability: 'CAPTURE', status: 'CAPTURED', needsPrior: true },
    { capability: 'ADJUST', status: 'AUTHORIZED', needsPrior: true },
    { capability: 'VOID', status: 'VOIDED', needsPrior: true },
    { capability: 'REFUND', status: 'REFUNDED', needsPrior: true },
  ];

  for (const { capability, status, needsPrior } of cases) {
    it(`${capability} approves and maps to ${status}`, () => {
      const outcome = MOCK_PROVIDER.execute({
        capability,
        amount: '20.00',
        operationRef: `ref_${capability}`,
        priorRef: needsPrior ? priorRef : undefined,
      });
      expect(outcome.approved).toBe(true);
      expect(outcome.status).toBe(status);
      expect(outcome.declineCode).toBeNull();
      expect(outcome.providerRef).toMatch(
        new RegExp(`^mock_${capability.toLowerCase()}_[0-9a-f]{20}$`)
      );
      expect(outcome.event.capability).toBe(capability);
      expect(outcome.event.eventType).toBe(`${capability}_APPROVED`);
      expect(outcome.event.amount?.toString()).toBe('20');
      expect(outcome.event.providerRef).toBe(outcome.providerRef);
    });
  }

  it('AUTH → CAPTURE is a distinct two-step path against the prior reference', () => {
    const auth = MOCK_PROVIDER.execute({
      capability: 'AUTH',
      amount: '48.00',
      operationRef: 'seed_ac',
    });
    expect(auth.status).toBe('AUTHORIZED');
    const capture = MOCK_PROVIDER.execute({
      capability: 'CAPTURE',
      amount: '48.00',
      operationRef: 'seed_ac',
      priorRef: auth.providerRef,
    });
    expect(capture.status).toBe('CAPTURED');
    // The two operations produce distinct references (capability is part of the seed).
    expect(capture.providerRef).not.toBe(auth.providerRef);
    expect(capture.event.payload).toMatchObject({ priorRef: auth.providerRef });
  });

  it('ADJUST is supported at the contract level and leaves the authorization in place (C5)', () => {
    const outcome = MOCK_PROVIDER.execute({
      capability: 'ADJUST',
      amount: '3.00',
      operationRef: 'seed_adj',
      priorRef,
    });
    expect(outcome.approved).toBe(true);
    expect(outcome.status).toBe('AUTHORIZED');
  });

  it('requires a prior reference for CAPTURE/ADJUST/VOID/REFUND', () => {
    for (const capability of ['CAPTURE', 'ADJUST', 'VOID', 'REFUND'] as PaymentCapability[]) {
      expect(() =>
        MOCK_PROVIDER.execute({ capability, amount: '10.00', operationRef: 'r' })
      ).toThrowError(/prior authorization reference/);
    }
  });
});

describe('MOCK — deterministic references and scriptable declines', () => {
  it('produces byte-identical references for identical inputs and different ones otherwise', () => {
    const a = MOCK_PROVIDER.execute({
      capability: 'SALE',
      amount: '20.00',
      operationRef: 'stable',
    });
    const b = MOCK_PROVIDER.execute({
      capability: 'SALE',
      amount: '20.00',
      operationRef: 'stable',
    });
    const c = MOCK_PROVIDER.execute({ capability: 'SALE', amount: '20.00', operationRef: 'other' });
    expect(a.providerRef).toBe(b.providerRef);
    expect(a.providerRef).not.toBe(c.providerRef);
  });

  it('declines a SALE/AUTH on a designated decline amount, with a normalized code + event', () => {
    const declined = MOCK_PROVIDER.execute({
      capability: 'SALE',
      amount: '10.13',
      operationRef: 'd',
    });
    expect(declined.approved).toBe(false);
    expect(declined.status).toBe('DECLINED');
    expect(declined.declineCode).toBe('GENERIC_DECLINE');
    expect(declined.event.eventType).toBe('SALE_DECLINED');
    expect(declined.event.payload).toMatchObject({
      approved: false,
      declineCode: 'GENERIC_DECLINE',
    });

    expect(
      MOCK_PROVIDER.execute({ capability: 'AUTH', amount: '5.51', operationRef: 'd' }).declineCode
    ).toBe('INSUFFICIENT_FUNDS');
    expect(
      MOCK_PROVIDER.execute({ capability: 'SALE', amount: '99.54', operationRef: 'd' }).declineCode
    ).toBe('EXPIRED_CARD');
  });

  it('never scripts a decline from the amount cents in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      for (const amount of ['10.13', '5.51', '99.54']) {
        const outcome = MOCK_PROVIDER.execute({ capability: 'SALE', amount, operationRef: 'p' });
        expect(outcome.approved).toBe(true);
        expect(outcome.declineCode).toBeNull();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never declines a post-authorization operation on a designated amount', () => {
    // A CAPTURE/VOID/REFUND of a valid authorization succeeds even when the amount
    // carries a decline cent code — only SALE/AUTH authorize funds.
    const capture = MOCK_PROVIDER.execute({
      capability: 'CAPTURE',
      amount: '10.13',
      operationRef: 'c',
      priorRef: 'mock_auth_x',
    });
    expect(capture.approved).toBe(true);
    expect(capture.status).toBe('CAPTURED');
  });

  it('carries no cardholder data on its event payloads', () => {
    const outcome = MOCK_PROVIDER.execute({
      capability: 'SALE',
      amount: '20.00',
      operationRef: 's',
    });
    const keys = Object.keys(outcome.event.payload).map((k) => k.toLowerCase());
    for (const forbidden of ['pan', 'cardnumber', 'cvv', 'cvc', 'track', 'pin']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// ── DB-backed event trail ─────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha58a_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  operator: `staff_op_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  brand: `brand_${suffix}`,
  menu: `menu_${suffix}`,
  section: `sec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  publication: `pub_${suffix}`,
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('./bills');
};

let deps: Deps;
let deviceId: string;

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

/** Cut a NONE bill for a fresh single-item order and return the bill + its payment
 * scaffold (a real payment row a payment event can hang off of). */
async function newBillWithPayment(): Promise<{ billId: string; paymentId: string }> {
  const key = randomBytes(6).toString('hex');
  const actor = { staffProfileId: ids.operator, deviceId, idempotencyKey: `k_${key}` };
  const scoped = (await import('@/lib/tenancy/scoped-db')).createTenantDb(orgId);
  const opened = await deps.orders.openOrder(scoped, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    actor,
    now: new Date('2026-08-19T18:00:00.000Z'),
  });
  await deps.orders.addItem(scoped, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: { ...actor, idempotencyKey: `k_${key}_i` },
  });
  const cut = await deps.bills.cutBills(scoped, {
    orderId: opened.orderId,
    branchId: ids.branch,
    split: { kind: 'NONE' },
    actor: { ...actor, idempotencyKey: `k_${key}_c` },
  });
  const billId = cut.billIds[0]!;
  const paymentId = await deps.withTenantDb(orgId, async (tx) => {
    const payment = await tx.restaurantPayment.create({
      data: {
        billId,
        provider: 'MOCK',
        capability: 'SALE',
        status: 'CAPTURED',
        amount: '12.50',
        staffProfileId: ids.operator,
        deviceId,
      },
      select: { id: true },
    });
    return payment.id;
  });
  return { billId, paymentId };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, orders, bills] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('./bills'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    orders,
    bills,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha58a-${suffix}`,
        legalName: 'Adapter Test Co',
        displayName: 'Adapter Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' });
    deviceId = enrolled.device.id;

    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
    await tx.restaurantProduct.create({
      data: { id: ids.product, name: 'Burger', categoryId: ids.category },
    });
    await tx.restaurantBrand.create({ data: { id: ids.brand, name: 'Acme' } });
    await tx.restaurantMenu.create({ data: { id: ids.menu, brandId: ids.brand, name: 'All Day' } });
    await tx.restaurantMenuSection.create({
      data: { id: ids.section, menuId: ids.menu, name: 'Food' },
    });
    await tx.restaurantMenuItem.create({
      data: {
        id: ids.menuItem,
        sectionId: ids.section,
        productId: ids.product,
        displayName: 'Burger',
      },
    });
    await tx.restaurantPriceList.create({
      data: { id: ids.priceList, name: 'Default', isDefault: true },
    });
    await tx.restaurantPriceListVersion.create({
      data: {
        id: ids.priceVersion,
        priceListId: ids.priceList,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        status: 'ACTIVE',
      },
    });
    await tx.restaurantPriceListEntry.create({
      data: { priceListVersionId: ids.priceVersion, productId: ids.product, price: '12.50' },
    });
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publication,
        branchId: ids.branch,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: [],
      },
    });
  });
});

describeIfDatabase('appendPaymentEvent (append-only trail, real DB)', () => {
  it('writes a sanitized event row that round-trips', async () => {
    const { paymentId } = await newBillWithPayment();
    const outcome = MOCK_PROVIDER.execute({
      capability: 'SALE',
      amount: '12.50',
      operationRef: `op_${paymentId}`,
    });
    const { eventId } = await read((tx) =>
      appendPaymentEvent(tx, {
        paymentId,
        capability: outcome.capability,
        eventType: outcome.event.eventType,
        amount: outcome.event.amount,
        providerRef: outcome.event.providerRef,
        payload: outcome.event.payload,
      })
    );
    const event = await read((tx) =>
      tx.restaurantPaymentEvent.findUnique({
        where: { id: eventId },
        select: {
          paymentId: true,
          capability: true,
          eventType: true,
          amount: true,
          providerRef: true,
        },
      })
    );
    expect(event?.paymentId).toBe(paymentId);
    expect(event?.capability).toBe('SALE');
    expect(event?.eventType).toBe('SALE_APPROVED');
    expect(event?.amount?.toString()).toBe('12.5');
    expect(event?.providerRef).toBe(outcome.providerRef);
  });

  it('rejects a payload carrying cardholder data before it is written', async () => {
    const { paymentId } = await newBillWithPayment();
    await expect(
      read((tx) =>
        appendPaymentEvent(tx, {
          paymentId,
          capability: 'SALE',
          eventType: 'SALE_APPROVED',
          payload: { provider: 'MOCK', card: { PAN: '4111111111111111' } },
        })
      )
    ).rejects.toMatchObject({ reason: 'FORBIDDEN_PAYLOAD_FIELD' });

    const count = await read((tx) => tx.restaurantPaymentEvent.count({ where: { paymentId } }));
    expect(count).toBe(0);
  });
});
