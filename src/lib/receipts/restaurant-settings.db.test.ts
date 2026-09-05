import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from './configuration';
import { listRestaurantReceiptLayouts, saveRestaurantReceiptLayout } from './restaurant-settings';

const database = process.env.TEST_DATABASE_URL;
if (database) process.env.DATABASE_URL = database;
const suffix = randomBytes(6).toString('hex');
const orgA = `receipt_a_${suffix}`;
const orgB = `receipt_b_${suffix}`;
const branchA = `receipt_branch_a_${suffix}`;
const branchB = `receipt_branch_b_${suffix}`;
const branchOther = `receipt_branch_other_${suffix}`;
let tenancy: typeof import('@/lib/tenancy/scoped-db');

describe.skipIf(!database)('receipt layout persistence with enforcing RLS role', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.createMany({
        data: [orgA, orgB].map((id) => ({ id, slug: id, legalName: id, displayName: id })),
      })
    );
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantBranch.createMany({
        data: [branchA, branchOther].map((id) => ({ id, organizationId: orgA, name: id })),
      })
    );
    await tenancy.withTenantDb(orgB, (db) =>
      db.restaurantBranch.create({ data: { id: branchB, organizationId: orgB, name: branchB } })
    );
  });
  afterAll(async () => {
    if (tenancy)
      await tenancy.withPlatformDb((db) =>
        db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
      );
  });
  it('persists across tenant transactions without changing another branch', async () => {
    const layout = {
      ...DEFAULT_RECEIPT_LAYOUT,
      paperWidth: 58 as const,
      footerText: 'Saved footer',
    };
    await tenancy.withTenantDb(orgA, (db) =>
      saveRestaurantReceiptLayout(db, orgA, { branchId: branchA, revision: 0, layout })
    );
    const rows = await tenancy.withTenantDb(orgA, (db) => listRestaurantReceiptLayouts(db, orgA));
    expect(rows.find((row) => row.id === branchA)).toMatchObject({ layout, revision: 1 });
    expect(rows.find((row) => row.id === branchOther)).toMatchObject({
      layout: DEFAULT_RECEIPT_LAYOUT,
      revision: 0,
    });
  });
  it('RLS hides foreign reads and writes even with a forged organization argument', async () => {
    expect(
      await tenancy.withTenantDb(orgB, (db) => listRestaurantReceiptLayouts(db, orgA))
    ).toEqual([]);
    await expect(
      tenancy.withTenantDb(orgB, (db) =>
        saveRestaurantReceiptLayout(db, orgA, {
          branchId: branchA,
          revision: 1,
          layout: DEFAULT_RECEIPT_LAYOUT,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('admits exactly one competing writer and can persist a reset', async () => {
    const input = {
      branchId: branchOther,
      revision: 0,
      layout: { ...DEFAULT_RECEIPT_LAYOUT, footerText: 'Concurrent edit' },
    };
    const write = () =>
      tenancy.withTenantDb(orgA, (db) => saveRestaurantReceiptLayout(db, orgA, input));
    const results = await Promise.allSettled([write(), write()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await tenancy.withTenantDb(orgA, (db) =>
      saveRestaurantReceiptLayout(db, orgA, {
        ...input,
        revision: 1,
        layout: DEFAULT_RECEIPT_LAYOUT,
      })
    );
    const rows = await tenancy.withTenantDb(orgA, (db) => listRestaurantReceiptLayouts(db, orgA));
    expect(rows.find((row) => row.id === branchOther)).toMatchObject({
      revision: 2,
      layout: DEFAULT_RECEIPT_LAYOUT,
    });
  });
  it('rolls settings back if the owning transaction fails', async () => {
    await expect(
      tenancy.withTenantDb(orgB, async (db) => {
        await saveRestaurantReceiptLayout(db, orgB, {
          branchId: branchB,
          revision: 0,
          layout: { ...DEFAULT_RECEIPT_LAYOUT, footerText: 'Must roll back' },
        });
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    const rows = await tenancy.withTenantDb(orgB, (db) => listRestaurantReceiptLayouts(db, orgB));
    expect(rows[0]).toMatchObject({ revision: 0, layout: DEFAULT_RECEIPT_LAYOUT });
  });
});
