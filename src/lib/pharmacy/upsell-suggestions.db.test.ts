/**
 * @vitest-environment node
 *
 * #730 against a REAL migrated PostgreSQL, as the restricted runtime role under FORCE RLS.
 * Counter upsell suggestions must only ever propose in-stock, saleable, non-prescription,
 * non-controlled, non-restricted, non-high-alert items from this branch — never an
 * Rx-only or controlled medicine, even when its name matches a rule.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the runtime role.
 * Without it the suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Family = 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let ledger: typeof import('./stock-ledger');
let upsell: typeof import('./upsell-suggestions');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const organizationId = `ups730_${run}`;
const scope = { organizationId, branchId: `ups730_branch_${run}`, actorId: 'ups730-actor' };
const otherBranchId = `ups730_other_${run}`;
const locations: Record<string, string> = {};

const tenant = <T>(work: (db: ScopedDb) => Promise<T>, timeout = 30_000) =>
  withTenantDb(organizationId, work, { userId: scope.actorId, timeout });

async function medicine(
  name: string,
  options: {
    family?: Family;
    dosageForm?: string;
    rx?: boolean;
    otc?: boolean;
    controlled?: boolean;
    restricted?: boolean;
    highAlert?: boolean;
    stockAt?: string | null;
  } = {}
) {
  return tenant(async (db) => {
    const created = await db.medicine.create({
      data: {
        organizationId,
        productName: `${name} ${run}`,
        productFamily: options.family ?? 'DEVICE',
        saleable: true,
        rx: options.rx ?? false,
        otc: options.otc ?? false,
        controlled: options.controlled ?? false,
        restricted: options.restricted ?? false,
        highAlert: options.highAlert ?? false,
        presentations: {
          create: {
            organizationId,
            presentation: 'Each',
            dosageForm: options.dosageForm ?? null,
          },
        },
      },
      include: { presentations: true },
    });
    const branchId = options.stockAt === undefined ? scope.branchId : options.stockAt;
    if (branchId) {
      const pack = await db.packLevel.create({
        data: {
          organizationId,
          presentationId: created.presentations[0]!.id,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'UNIT',
          unitsPerParent: 1,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: created.id,
          batchNumber: `UPS-${randomUUID().slice(0, 8)}`,
          expiresAt: new Date('2031-01-01T00:00:00.000Z'),
          expiryPrecision: 'DAY',
        },
      });
      await ledger.receiveLot(db, { ...scope, branchId }, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: locations[branchId]!,
        unitsPerPack: 1,
        supplierName: 'Test',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: 45_000,
        receivedExpiresAt: new Date('2031-01-01T00:00:00.000Z'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 5,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
    }
    return created.id;
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  ledger = await import('./stock-ledger');
  upsell = await import('./upsell-suggestions');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  await tenant(async (db) => {
    for (const branchId of [scope.branchId, otherBranchId]) {
      await db.pharmacyBranch.create({
        data: {
          id: branchId,
          organizationId,
          code: branchId,
          name: 'Upsell',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { organizationId, branchId, code: randomUUID(), name: 'Stock', kind: 'STORE' },
      });
      locations[branchId] = location.id;
    }
  });
}, 60_000);

describeDatabase('#730 counter upsell suggestions (database)', () => {
  it('suggests only safe, in-stock, same-branch complementary items', async () => {
    const trigger = await medicine('Salbutamol Inhaler', {
      family: 'PHARMACEUTICAL',
      dosageForm: 'Inhaler',
      rx: true,
    });
    const device = await medicine('Spacer Device');
    const otcPharma = await medicine('Spacer OTC', { family: 'PHARMACEUTICAL', otc: true });
    const rxOnly = await medicine('Spacer Rx', { rx: true });
    const controlled = await medicine('Spacer Controlled', { controlled: true, otc: true });
    const restricted = await medicine('Spacer Restricted', { restricted: true });
    const highAlert = await medicine('Spacer HighAlert', { highAlert: true });
    const plainPharma = await medicine('Spacer Pharma', { family: 'PHARMACEUTICAL' });
    const outOfStock = await medicine('Spacer Empty', { stockAt: null });
    const elsewhere = await medicine('Spacer Elsewhere', { stockAt: otherBranchId });

    const rows = await tenant((db) =>
      upsell.findUpsellSuggestions(db, scope, { medicineIds: [trigger], limit: 20 })
    );
    const ids = rows.map((row) => row.medicineId);

    expect(ids).toEqual(expect.arrayContaining([device, otcPharma]));
    for (const forbidden of [
      trigger,
      rxOnly,
      controlled,
      restricted,
      highAlert,
      plainPharma,
      outOfStock,
      elsewhere,
    ]) {
      expect(ids).not.toContain(forbidden);
    }
    expect(rows.every((row) => row.ruleId === 'inhaler-spacer')).toBe(true);
  });

  it('suggests nothing for a bill whose items fire no rule', async () => {
    const vitamin = await medicine('Vitamin C', { family: 'PHARMACEUTICAL', otc: true });
    const rows = await tenant((db) =>
      upsell.findUpsellSuggestions(db, scope, { medicineIds: [vitamin] })
    );
    expect(rows).toEqual([]);
  });
});
