/**
 * DEV-576 — the tenant medicine-name list against PostgreSQL under RLS.
 *
 * Product, brand, alias and ingredient names are read through a tenant-scoped client;
 * another tenant's catalogue is never visible, and legacy codes are not names.
 * Skipped unless TEST_DATABASE_URL is set (a NOSUPERUSER NOBYPASSRLS role).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it, describe } from 'vitest';

import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { containsMedicineName, readTenantMedicineNames } from './medicine-names';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const client = url ? db : null;
const describeIfDatabase = url ? describe : describe.skip;

const orgA = `org_mn576_a_${randomUUID()}`;
const orgB = `org_mn576_b_${randomUUID()}`;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) {
  if (!client) throw new Error('TEST_DATABASE_URL required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      return work(tx as ScopedDb);
    },
    { timeout: 30_000 }
  );
}

async function seed(organizationId: string, productName: string, brandName: string, salt: string) {
  await inOrg(organizationId, async (dbx) => {
    const medicine = await dbx.medicine.create({
      data: { organizationId, productName, brandName, productFamily: 'PHARMACEUTICAL' },
    });
    await dbx.medicineAlias.createMany({
      data: [
        {
          organizationId,
          medicineId: medicine.id,
          type: 'TRANSLITERATION',
          value: `${brandName}a`,
          normalizedValue: `${brandName}a`.toLowerCase(),
        },
        {
          organizationId,
          medicineId: medicine.id,
          type: 'LEGACY_CODE',
          value: `NEW-${organizationId.slice(-4)}`,
          normalizedValue: `new${organizationId.slice(-4)}`,
        },
      ],
    });
    await dbx.ingredient.create({ data: { organizationId, name: salt } });
  });
}

beforeAll(async () => {
  if (!client) return;
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
    for (const org of [orgA, orgB]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      );
    }
  });
  await seed(orgA, 'Panadol Extra 500mg Tablet', 'Panadol', 'Paracetamol');
  await seed(orgB, 'Brufen 400mg Tablet', 'Brufen', 'Ibuprofen');
  await inOrg(orgA, (dbx) =>
    dbx.medicine.create({
      data: {
        organizationId: orgA,
        productName: 'Calpol Syrup 120ml',
        productFamily: 'PHARMACEUTICAL',
      },
    })
  );
});
afterAll(() => client?.$disconnect());

describeIfDatabase('tenant medicine names (DEV-576)', () => {
  it("reads only the tenant's own product, brand, alias and ingredient names", async () => {
    const names = await inOrg(orgA, (dbx) => readTenantMedicineNames(dbx));
    expect(names).toEqual(
      new Set([
        'panadol extra 500mg tablet',
        'panadol extra',
        'panadol',
        'panadola',
        'paracetamol',
        'calpol syrup 120ml',
        'calpol',
      ])
    );
    expect(containsMedicineName('Calpol is back! Reply STOP to opt out.', names)).toBe(true);
    expect(containsMedicineName('Panadol is back! Reply STOP to opt out.', names)).toBe(true);
    expect(containsMedicineName('Brufen is back! Reply STOP to opt out.', names)).toBe(false);
    const other = await inOrg(orgB, (dbx) => readTenantMedicineNames(dbx));
    expect(other.has('ibuprofen')).toBe(true);
    expect(other.has('panadol')).toBe(false);
  });
});
