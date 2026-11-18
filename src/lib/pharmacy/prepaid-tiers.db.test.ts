// @vitest-environment node
/**
 * DEV-863: customer prepaid money on real PostgreSQL.
 *
 * Needs a fully migrated, disposable loopback database:
 * - TEST_DATABASE_URL: a LOGIN NOSUPERUSER NOBYPASSRLS runtime role (every service call runs here);
 * - PHARMACY_TEST_OWNER_DATABASE_URL: a role that can seed both tenants' parent rows.
 * Without both URLs the suite is skipped.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertPrepaidPin,
  movePrepaid,
  PrepaidError,
  PrepaidPinError,
  publishPrepaidSettings,
  setPrepaidPin,
} from './prepaid-tiers';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const suite = runtimeUrl && ownerUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `pp_${label}_${suffix}`;
const tenants = {
  a: {
    organizationId: id('org_a'),
    branchId: id('branch_a'),
    actorId: id('owner_a'),
    customerId: id('customer_a'),
  },
  b: {
    organizationId: id('org_b'),
    branchId: id('branch_b'),
    actorId: id('owner_b'),
    customerId: id('customer_b'),
  },
};
type Tenant = (typeof tenants)['a'];
const scopeOf = (t: Tenant) => ({
  organizationId: t.organizationId,
  branchId: t.branchId,
  actorId: t.actorId,
});
const bronze = { name: 'Bronze', upfrontMinor: 10000, discountBasisPoints: 200 };

suite('DEV-863 prepaid balances on PostgreSQL', () => {
  let owner: pg.Client;
  let db: PrismaClient;
  /** One runtime-role transaction scoped to a tenant, as the app's tenant DB opens it. */
  const tenant = <T>(t: Tenant, run: (tx: ScopedDb) => Promise<T>) =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${t.organizationId}, true),
          set_config('app.is_platform_admin', 'false', true)`;
        return run(tx as ScopedDb);
      },
      { timeout: 30_000 }
    );
  const account = (t: Tenant) =>
    tenant(t, (tx) =>
      tx.pharmacyPrepaidAccount.findFirst({
        where: { organizationId: t.organizationId, customerId: t.customerId },
      })
    );
  const entries = (t: Tenant) =>
    tenant(t, (tx) =>
      tx.pharmacyPrepaidEntry.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { sequence: 'asc' },
      })
    );
  const pay = (t: Tenant, amountMinor: number, kind: 'PAYMENT' | 'SPEND' | 'REFUND' = 'PAYMENT') =>
    tenant(t, (tx) =>
      movePrepaid(tx, scopeOf(t), {
        customerId: t.customerId,
        kind,
        amountMinor,
        idempotencyKey: `${kind}-${randomUUID()}`,
      })
    );
  const settings = (t: Tenant, refundable: boolean) =>
    tenant(t, (tx) => publishPrepaidSettings(tx, scopeOf(t), { refundable, tiers: [bronze] }));
  /** Runs raw SQL as the runtime role in a tenant transaction; the error, if any, is at commit. */
  const raw = (t: Tenant, sql: Prisma.Sql) => tenant(t, (tx) => tx.$executeRaw(sql));

  beforeAll(async () => {
    for (const url of [runtimeUrl!, ownerUrl!])
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Refusing to run prepaid money probes against a non-local database.');
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) });
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    for (const t of Object.values(tenants)) {
      await owner.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "updatedAt")
         VALUES ($1, $1, 'Prepaid fixture', 'Prepaid fixture', 'ACTIVE', now())`,
        [t.organizationId]
      );
      await owner.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'Owner', 'Owner', now())`,
        [`${t.organizationId}_department`, t.organizationId]
      );
      await owner.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, role, "updatedAt")
         VALUES ($1, $2, 'Owner', $3, 'Owner', 'Owner', 'ADMIN', now())`,
        [t.actorId, t.organizationId, `${t.actorId}@prepaid.test`]
      );
      await owner.query(
        `INSERT INTO pharmacy_branches
          (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Main', 'Synthetic address', 'Lahore', 'PB', now())`,
        [t.branchId, t.organizationId]
      );
      await owner.query(
        `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Prepaid customer', now())`,
        [`${t.customerId}_patient`, t.organizationId]
      );
      await owner.query(
        `INSERT INTO pharmacy_customers (id, "organizationId", "patientId", "displayName", "updatedAt")
         VALUES ($1, $2, $3, 'Prepaid customer', now())`,
        [t.customerId, t.organizationId, `${t.customerId}_patient`]
      );
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
    await owner?.end();
  });

  it('runs as a restricted role against ENABLE and FORCE row-level security on every new table', async () => {
    const [role] = await tenant(
      tenants.a,
      (tx) =>
        tx.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const { rows } = await owner.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('pharmacy_prepaid_tier_versions','pharmacy_prepaid_accounts','pharmacy_prepaid_entries')
       ORDER BY relname`
    );
    expect(rows).toEqual(
      [
        'pharmacy_prepaid_accounts',
        'pharmacy_prepaid_entries',
        'pharmacy_prepaid_tier_versions',
      ].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it('enters the tier on the upfront amount and records every movement as a reconciled ledger entry', async () => {
    await settings(tenants.a, true);
    await settings(tenants.b, true);
    await pay(tenants.a, 6000);
    expect(await account(tenants.a)).toMatchObject({ balanceMinor: 6000, tierName: null });
    await pay(tenants.a, 4000);
    expect(await account(tenants.a)).toMatchObject({
      balanceMinor: 10000,
      refundableMinor: 10000,
      qualifyingMinor: 10000,
      tierName: 'Bronze',
      discountBasisPoints: 200,
    });
    await pay(tenants.a, 1500, 'SPEND');
    await pay(tenants.a, 500, 'REFUND');
    const ledger = await entries(tenants.a);
    expect(ledger.map((e) => [e.sequence, e.kind, e.amountMinor, e.balanceAfterMinor])).toEqual([
      [1, 'PAYMENT', 6000, 6000],
      [2, 'PAYMENT', 4000, 10000],
      [3, 'SPEND', -1500, 8500],
      [4, 'REFUND', -500, 8000],
    ]);
    const current = await account(tenants.a);
    expect(current!.balanceMinor).toBe(ledger.reduce((n, e) => n + e.amountMinor, 0));
    expect(current!.refundableMinor).toBe(ledger.reduce((n, e) => n + e.refundableDeltaMinor, 0));
    const audit = await tenant(tenants.a, (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: tenants.a.organizationId, action: 'pharmacy.prepaid.tierChanged' },
      })
    );
    expect(audit.map((row) => row.metadata)).toContainEqual(
      expect.objectContaining({ before: null, after: 'Bronze' })
    );
  });

  it('never lets a balance go negative, through the service or through SQL', async () => {
    const before = await account(tenants.a);
    await expect(pay(tenants.a, before!.balanceMinor + 1, 'SPEND')).rejects.toBeInstanceOf(
      PrepaidError
    );
    await expect(
      raw(
        tenants.a,
        Prisma.sql`UPDATE pharmacy_prepaid_accounts SET "balanceMinor" = -1, "refundableMinor" = 0
          WHERE "customerId" = ${tenants.a.customerId}`
      )
    ).rejects.toThrow(/check constraint/);
    expect(await account(tenants.a)).toEqual(before);
  });

  it('lets only one of two concurrent sales spend the same funds', async () => {
    const t = tenants.b;
    await pay(t, 10000);
    const results = await Promise.allSettled([pay(t, 8000, 'SPEND'), pay(t, 8000, 'SPEND')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toBeInstanceOf(PrepaidError);
    expect(await account(t)).toMatchObject({ balanceMinor: 2000 });
    expect((await entries(t)).filter((e) => e.kind === 'SPEND')).toHaveLength(1);
  });

  it('refuses at commit any balance, tier or entry snapshot that does not match the ledger', async () => {
    const t = tenants.a;
    const before = await account(t);
    const ledger = await entries(t);
    // Money moved with no ledger entry.
    await expect(
      raw(
        t,
        Prisma.sql`UPDATE pharmacy_prepaid_accounts SET "balanceMinor" = "balanceMinor" + 100
          WHERE "customerId" = ${t.customerId}`
      )
    ).rejects.toThrow(/must reconcile to its ledger/);
    // A tier gain or loss with no immutable, audited entry.
    await expect(
      raw(
        t,
        Prisma.sql`UPDATE pharmacy_prepaid_accounts SET "tierName" = 'Gold', "discountBasisPoints" = 5000
          WHERE "customerId" = ${t.customerId}`
      )
    ).rejects.toThrow(/tier change requires a ledger entry/);
    // An entry whose post-balance misstates the running total, though the sums reconcile.
    const last = ledger.at(-1)!;
    await expect(
      tenant(t, async (tx) => {
        await tx.$executeRaw`UPDATE pharmacy_prepaid_accounts
          SET "balanceMinor" = "balanceMinor" + 100, "refundableMinor" = "refundableMinor" + 100
          WHERE "customerId" = ${t.customerId}`;
        await tx.$executeRaw`INSERT INTO pharmacy_prepaid_entries
          (id, "organizationId", "branchId", "accountId", sequence, kind, "amountMinor",
           "refundableDeltaMinor", "balanceAfterMinor", "refundableAfterMinor", "qualifyingAfterMinor",
           "discountBasisPointsAfter", "tierBefore", "tierAfter", "tierVersionAfterId", "actorId",
           "idempotencyKey")
          VALUES (${randomUUID()}, ${t.organizationId}, ${t.branchId}, ${before!.id},
           ${last.sequence + 1}, 'PAYMENT', 100, 100, 999999, ${before!.refundableMinor + 100},
           ${before!.qualifyingMinor}, ${before!.discountBasisPoints}, ${before!.tierName},
           ${before!.tierName}, ${before!.tierVersionId}, ${t.actorId}, ${randomUUID()})`;
      })
    ).rejects.toThrow(/must match its ledger position/);
    // Entries are append-only.
    await expect(
      raw(
        t,
        Prisma.sql`UPDATE pharmacy_prepaid_entries SET "amountMinor" = 1 WHERE id = ${last.id}`
      )
    ).rejects.toThrow();
    await expect(
      raw(t, Prisma.sql`DELETE FROM pharmacy_prepaid_entries WHERE id = ${last.id}`)
    ).rejects.toThrow();
    expect(await account(t)).toEqual(before);
    expect(await entries(t)).toEqual(ledger);
  });

  it('keeps every tenant’s balances, ledger and tiers out of another tenant’s reach', async () => {
    const a = tenants.a;
    const b = tenants.b;
    const seen = await tenant(b, async (tx) => ({
      accounts: await tx.pharmacyPrepaidAccount.findMany(),
      entries: await tx.pharmacyPrepaidEntry.findMany(),
      tiers: await tx.pharmacyPrepaidTierVersion.findMany(),
    }));
    for (const rows of Object.values(seen)) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organizationId === b.organizationId)).toBe(true);
    }
    const before = await account(a);
    expect(
      await raw(
        b,
        Prisma.sql`UPDATE pharmacy_prepaid_accounts SET "pinFailedAttempts" = 3
          WHERE "customerId" = ${a.customerId}`
      )
    ).toBe(0);
    // Tenant B cannot spend tenant A's money, not even by naming tenant A's scope outright.
    await expect(
      tenant(b, (tx) =>
        movePrepaid(tx, scopeOf(b), {
          customerId: a.customerId,
          kind: 'SPEND',
          amountMinor: 100,
          idempotencyKey: randomUUID(),
        })
      )
    ).rejects.toBeInstanceOf(PrepaidError);
    await expect(
      tenant(b, (tx) =>
        movePrepaid(tx, scopeOf(a), {
          customerId: a.customerId,
          kind: 'SPEND',
          amountMinor: 100,
          idempotencyKey: randomUUID(),
        })
      )
    ).rejects.toThrow();
    expect(await account(a)).toEqual(before);
  });

  it('refuses a cash refund of funds paid under the owner’s non-refundable setting', async () => {
    const b = tenants.b;
    await settings(b, false);
    const paid = await pay(b, 5000);
    expect(paid).toMatchObject({ refundable: false });
    const before = await account(b);
    expect(before!.refundableMinor).toBe(before!.balanceMinor - 5000);
    await expect(pay(b, before!.refundableMinor + 1, 'REFUND')).rejects.toThrow('not refundable');
    expect(await account(b)).toEqual(before);
    expect((await entries(b)).filter((e) => e.kind === 'REFUND')).toHaveLength(0);
  });

  it('spends only with the customer’s own PIN, stored as a hash', async () => {
    const a = tenants.a;
    await tenant(a, (tx) =>
      setPrepaidPin(tx, scopeOf(a), { customerId: a.customerId, pin: '4821' })
    );
    const stored = await account(a);
    expect(stored!.spendPinHash).toBeTruthy();
    expect(stored!.spendPinHash).not.toContain('4821');
    await expect(
      tenant(a, (tx) => assertPrepaidPin(tx, a.organizationId, a.customerId, '0000'))
    ).rejects.toBeInstanceOf(PrepaidPinError);
    await expect(
      tenant(a, (tx) => assertPrepaidPin(tx, a.organizationId, a.customerId, undefined))
    ).rejects.toBeInstanceOf(PrepaidPinError);
    await expect(
      tenant(a, (tx) => assertPrepaidPin(tx, a.organizationId, a.customerId, '4821'))
    ).resolves.toBeUndefined();
    // Tenant B cannot test PINs against tenant A's customer.
    await expect(
      tenant(tenants.b, (tx) => assertPrepaidPin(tx, a.organizationId, a.customerId, '4821'))
    ).rejects.toBeInstanceOf(PrepaidPinError);
  });

  it('refuses at commit an inserted sale line that claims a tier discount without allocation evidence', async () => {
    const a = tenants.a;
    const medicine = id('medicine');
    const presentation = id('presentation');
    const pack = id('pack');
    const sale = id('sale');
    await owner.query(
      `INSERT INTO pharmacy_medicines (id, "organizationId", "productName", "productFamily", "updatedAt")
       VALUES ($1, $2, 'Fixture medicine', 'PHARMACEUTICAL', now())`,
      [medicine, a.organizationId]
    );
    await owner.query(
      `INSERT INTO pharmacy_presentations (id, "organizationId", "medicineId", presentation, "updatedAt")
       VALUES ($1, $2, $3, 'tablet', now())`,
      [presentation, a.organizationId, medicine]
    );
    await owner.query(
      `INSERT INTO pharmacy_pack_levels
        (id, "organizationId", "presentationId", "versionGroupId", version, level, "unitsPerParent", "effectiveFrom")
       VALUES ($1, $2, $3, $1, 1, 'UNIT', 1, now())`,
      [pack, a.organizationId, presentation]
    );
    await owner.query(
      `INSERT INTO pharmacy_sales (id, "organizationId", "branchId", "createdByUserId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [sale, a.organizationId, a.branchId, a.actorId]
    );
    const line = (tier: Prisma.Sql) => Prisma.sql`INSERT INTO pharmacy_sale_lines
      (id, "organizationId", "branchId", "saleId", "medicineId", "presentationId", "packLevelId",
       "saleUnit", quantity, "canonicalUnitsPerSaleUnit", "canonicalUnits", "unitPriceMinor",
       "proRataCeilingMinor", "unitCostMinor", "idempotencyKey", "grossMinor", "discountMinor",
       "discountKind", "approvalPolicy", "approvedByUserId",
       "tierDiscountMinor", "tierName", "tierAllocationDiscounts")
      VALUES (${randomUUID()}, ${a.organizationId}, ${a.branchId}, ${sale}, ${medicine},
       ${presentation}, ${pack}, 'UNIT', 1, 1, 1, 1000, 1000, 500, ${randomUUID()}, 1000, 50,
       'DISCOUNT', 'prepaid-tier:fixture', ${a.actorId}, ${tier})`;
    await expect(
      raw(a, line(Prisma.sql`50, 'Bronze', '{"no-such-allocation": 50}'::jsonb`))
    ).rejects.toThrow(/price floor/);
    await expect(raw(a, line(Prisma.sql`50, NULL, NULL`))).rejects.toThrow(/check constraint/);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM pharmacy_sale_lines WHERE "saleId" = $1`,
      [sale]
    );
    expect(rows[0].n).toBe(0);
  });
});
