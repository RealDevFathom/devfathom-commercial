import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_khata_a_${suffix}`;
const orgB = `org_khata_b_${suffix}`;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let khata: typeof import('./family-khata');
type Fixture = {
  organizationId: string;
  branchId: string;
  actorId: string;
  saleId: string;
  familyAccountId: string;
  memberId: string;
};
let a: Fixture, sibling: Fixture, foreign: Fixture;
async function fixture(organizationId: string, label: string): Promise<Fixture> {
  return tenant(organizationId, async (db: ScopedDb) => {
    await db.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: {
        id: organizationId,
        slug: organizationId,
        legalName: label,
        displayName: label,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        currency: 'PKR',
      },
    });
    const branch = await db.pharmacyBranch.create({
      data: {
        organizationId,
        code: label,
        name: label,
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Private clinical name' },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: 'Retail name' },
    });
    const family = await db.pharmacyFamilyAccount.create({
      data: {
        organizationId,
        branchId: branch.id,
        payerCustomerId: customer.id,
        displayName: 'Family',
        creditLimitMinor: 1000,
      },
    });
    const member = await db.pharmacyFamilyMember.create({
      data: {
        organizationId,
        branchId: branch.id,
        familyAccountId: family.id,
        customerId: customer.id,
      },
    });
    const sale = await db.pharmacySale.create({
      data: {
        organizationId,
        branchId: branch.id,
        customerId: customer.id,
        createdByUserId: 'owner',
      },
    });
    // More than ten entries proves that no ten-sale snapshot is used.
    for (let index = 0; index < 12; index++)
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          kind: 'CHARGE',
          memberId: member.id,
          dueAt: new Date(),
          amountMinor: 50,
          actorId: 'owner',
        },
      });
    return {
      organizationId,
      branchId: branch.id,
      actorId: 'owner',
      saleId: sale.id,
      familyAccountId: family.id,
      memberId: member.id,
    };
  });
}
function inScope<T>(scope: Fixture, run: (db: ScopedDb) => Promise<T>) {
  return tenant(scope.organizationId, async (db) => {
    await db.$queryRawUnsafe(
      "SELECT set_config('app.current_branch_id', $1, true)",
      scope.branchId
    );
    return run(db);
  });
}
beforeAll(async () => {
  if (!url) return;
  tenant = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  khata = await import('./family-khata');
  a = await fixture(orgA, 'A');
  sibling = await fixture(orgA, 'Sibling');
  foreign = await fixture(orgB, 'Foreign');
});
suite('family Khata restricted PostgreSQL', () => {
  it('runs under LOGIN NOSUPERUSER NOBYPASSRLS', async () => {
    const roles = await inScope(a, (db) =>
      db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
        'SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname=current_user'
      )
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: true }]);
  });
  it('uses all twelve ledger entries and allows the exact limit', async () => {
    await inScope(a, async (db) => {
      expect(await khata.readKhataBalance(db, a, a.familyAccountId)).toBe(600);
      await khata.authorizeKhataCharge(db, a, { ...a, amountMinor: 400 }, { authorized: false });
      const statement = await khata.readSaleKhataStatement(db, a, a.saleId, a.familyAccountId);
      expect(statement.entries).toHaveLength(12);
      expect(JSON.stringify(statement)).not.toContain('Private clinical name');
    });
  });
  it('rejects sibling-branch substitution and enforces tenant RLS even without a tenant predicate', async () => {
    await inScope(a, async (db) => {
      expect(await khata.readSaleKhataAccounts(db, a, sibling.saleId)).toEqual([]);
      expect(await khata.readKhataBalance(db, a, sibling.familyAccountId)).toBe(0);
      expect(
        await db.pharmacyKhataEvent.findMany({
          where: { familyAccountId: foreign.familyAccountId },
        })
      ).toEqual([]);
    });
    await expect(
      inScope(a, (db) => khata.readSaleKhataStatement(db, a, a.saleId, sibling.familyAccountId))
    ).rejects.toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
  });
  it('rejects stale override and rolls back the limit and audit together', async () => {
    await expect(
      inScope(a, (db) =>
        khata.authorizeKhataCharge(
          db,
          a,
          { ...a, amountMinor: 401, ownerOverride: true },
          { authorized: true, passwordAuthenticatedAt: Date.now() - 301000 }
        )
      )
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    await inScope(a, async (db) => {
      expect(
        (await db.pharmacyFamilyAccount.findFirst({ where: { id: a.familyAccountId } }))!
          .creditLimitMinor
      ).toBe(1000);
      expect(
        await db.pharmacyKhataLimitDecision.count({ where: { familyAccountId: a.familyAccountId } })
      ).toBe(0);
    });
  });
  it('serializes competing charges at the family limit', async () => {
    const charge = () =>
      inScope(a, async (db) => {
        await khata.authorizeKhataCharge(db, a, { ...a, amountMinor: 300 }, { authorized: false });
        await db.pharmacyKhataEvent.create({
          data: {
            organizationId: orgA,
            branchId: a.branchId,
            familyAccountId: a.familyAccountId,
            kind: 'CHARGE',
            memberId: a.memberId,
            dueAt: new Date(),
            amountMinor: 300,
            actorId: a.actorId,
          },
        });
      });
    const results = await Promise.allSettled([charge(), charge()]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(await inScope(a, (db) => khata.readKhataBalance(db, a, a.familyAccountId))).toBe(900);
  });
  it('audits a fresh owner override and preserves append-only history', async () => {
    await inScope(a, (db) =>
      khata.authorizeKhataCharge(
        db,
        a,
        { ...a, amountMinor: 200, ownerOverride: true },
        { authorized: true, passwordAuthenticatedAt: Date.now() }
      )
    );
    const decision = await inScope(a, (db) =>
      db.pharmacyKhataLimitDecision.findFirst({ where: { familyAccountId: a.familyAccountId } })
    );
    expect(decision).toMatchObject({
      appliedLimitMinor: 1100,
      ownerActorId: 'owner',
      reasons: expect.objectContaining({ ownerAuthorizedByUserId: 'owner' }),
    });
    await expect(
      inScope(a, (db) =>
        db.pharmacyKhataEvent.updateMany({
          where: { familyAccountId: a.familyAccountId },
          data: { amountMinor: 1 },
        })
      )
    ).rejects.toThrow();
    await expect(
      inScope(a, (db) =>
        db.pharmacyKhataEvent.deleteMany({ where: { familyAccountId: a.familyAccountId } })
      )
    ).rejects.toThrow();
  });
});
