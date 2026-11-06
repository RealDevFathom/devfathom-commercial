/** Run only against a migrated disposable DB through a NOSUPERUSER/NOBYPASSRLS role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { financialStatements } from './financial-statements';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const tag = randomUUID();
const org = `journal_a_${tag}`;
const foreignOrg = `journal_b_${tag}`;
const branch = `branch_a_${tag}`;
const otherBranch = `branch_other_${tag}`;
const foreignBranch = `branch_b_${tag}`;
const actor = `actor_a_${tag}`;
const foreignActor = `actor_b_${tag}`;
const window = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
  page: 1,
};
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

async function fixture(organizationId: string, branchId: string, actorId: string, number: number) {
  return withTenantDb(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: branchId,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Test ${branchId}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Test' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId,
        versionGroupId: `pack-${branchId}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const sale = await db.pharmacySale.create({
      data: { organizationId, branchId, createdByUserId: actorId, receiptNumber: number },
    });
    return db.pharmacySaleLine.create({
      data: {
        organizationId,
        branchId,
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId,
        packLevelId: pack.id,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        canonicalUnits: 1,
        unitPriceMinor: 100,
        grossMinor: 100,
        proRataCeilingMinor: 100,
        unitCostMinor: 50,
        idempotencyKey: `line-${branchId}`,
      },
    });
  });
}
async function entry(
  organizationId: string,
  branchId: string,
  id: string,
  sourceId: string,
  actorId: string
) {
  await withTenantDb(organizationId, (db: ScopedDb) =>
    db.financeJournalEntry.create({
      data: {
        id,
        organizationId,
        branchId,
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId,
        description: id,
        actorId,
        occurredAt: new Date('2026-10-03'),
        idempotencyKey: id,
        lines: {
          create: [
            { branchId, accountCode: 'CASH', side: 'DEBIT', amountMinor: 100 },
            { branchId, accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 100 },
          ],
        },
      },
    })
  );
}
beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt") SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
      [org, foreignOrg]
    )
  );
  for (const [organizationId, actorId] of [
    [org, actor],
    [foreignOrg, foreignActor],
  ]) {
    await withTenantDb(organizationId!, async (db) => {
      await db.organizationDepartment.create({
        data: { organizationId: organizationId!, key: 'test', name: 'Test' },
      });
      await db.user.create({
        data: {
          id: actorId!,
          organizationId: organizationId!,
          name: organizationId === org ? 'Ayesha' : 'Foreign actor',
          email: `${actorId}@example.test`,
          department: 'test',
          title: 'Test',
        },
      });
    });
  }
  const line = await fixture(org, branch, actor, 42);
  const otherLine = await fixture(org, otherBranch, actor, 99);
  const foreignLine = await fixture(foreignOrg, foreignBranch, foreignActor, 88);
  await entry(org, branch, `ok-${tag}`, line.id, actor);
  await entry(org, branch, `wrong-branch-${tag}`, otherLine.id, foreignActor);
  await entry(org, otherBranch, `other-${tag}`, otherLine.id, actor);
  await entry(foreignOrg, foreignBranch, `foreign-${tag}`, foreignLine.id, foreignActor);
}, 60_000);

suite('financial statements journal under PostgreSQL RLS', () => {
  it('returns only scoped entries and does not resolve a foreign branch or actor', async () => {
    const report = await withTenantDb(org, (db) =>
      financialStatements(db, { organizationId: org, branchId: branch }, window)
    );
    expect(report.journalCount).toBe(2);
    const byId = Object.fromEntries(report.journal.map((row) => [row.id, row]));
    expect(byId[`ok-${tag}`]).toMatchObject({
      billNumber: 42,
      actorDisplayName: 'Ayesha',
      eventLabel: 'Sale',
      lines: expect.arrayContaining([expect.objectContaining({ amountMinor: 100 })]),
    });
    expect(byId[`wrong-branch-${tag}`]).toMatchObject({ billNumber: null, actorDisplayName: null });
    const denied = await withTenantDb(org, (db) =>
      financialStatements(db, { organizationId: foreignOrg, branchId: foreignBranch }, window)
    );
    expect(denied.journal).toEqual([]);
    expect(denied.journalCount).toBe(0);
  });
});
