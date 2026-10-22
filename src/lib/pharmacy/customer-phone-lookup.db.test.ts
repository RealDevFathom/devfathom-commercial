import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_phone_a_${suffix}`;
const orgB = `org_phone_b_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let lookup: typeof import('./customer-phone-lookup').lookupPharmacyCustomerByPhone;

async function createCustomer(organizationId: string, phone: string, displayName: string) {
  return withTenantDb(organizationId, async (db) => {
    await db.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: {
        id: organizationId,
        slug: organizationId,
        legalName: organizationId,
        displayName: organizationId,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        currency: 'PKR',
      },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName, phone },
    });
    return db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName },
    });
  });
}

beforeAll(async () => {
  if (!url) return;
  withTenantDb = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  lookup = (await import('./customer-phone-lookup')).lookupPharmacyCustomerByPhone;
});

suite('pharmacy customer phone identity under forced RLS', () => {
  it('allows the same phone across organizations and rejects it within one organization', async () => {
    await createCustomer(orgA, '0300-1234567', 'A');
    await createCustomer(orgB, '+92 300 1234567', 'B');
    await expect(createCustomer(orgA, '3001234567', 'duplicate A')).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('returns the current tenant match and nothing from another tenant', async () => {
    await expect(withTenantDb(orgA, (db) => lookup(db, '03001234567'))).resolves.toMatchObject({
      displayName: 'A',
    });
    await expect(withTenantDb(orgA, (db) => lookup(db, '0311-7654321'))).resolves.toBeNull();
    await createCustomer(orgB, '0311-7654321', 'B only');
    await expect(withTenantDb(orgA, (db) => lookup(db, '0311-7654321'))).resolves.toBeNull();
  });
});
