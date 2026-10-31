import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Fixture writes require an explicit test database, never the ambient application database.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_report_khata_a_${suffix}`;
const orgB = `org_report_khata_b_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let readCommandCentre: typeof import('./reports').readPharmacyOwnerCommandCentre;

type KhataFixture = { organizationId: string; branchId: string; familyAccountId: string };

async function createFixture(
  organizationId: string,
  label: string,
  amounts: {
    overdue: number[];
    partial?: { amount: number; paid: number; dishonoured?: number };
    unlinked?: { paid: number; dishonoured: number };
    future?: number;
  },
  existingBranchId?: string
): Promise<KhataFixture> {
  return withTenantDb(organizationId, async (db: ScopedDb) => {
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
    const branch = existingBranchId
      ? { id: existingBranchId }
      : await db.pharmacyBranch.create({
          data: {
            organizationId,
            code: label,
            name: label,
            addressLine: '1 Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: `${label} patient` },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: `${label} customer` },
    });
    const family = await db.pharmacyFamilyAccount.create({
      data: {
        organizationId,
        branchId: branch.id,
        payerCustomerId: customer.id,
        displayName: `${label} family`,
        creditLimitMinor: 0,
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
    const charge = async (amountMinor: number, dueAt: Date) =>
      db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          memberId: member.id,
          kind: 'CHARGE',
          amountMinor,
          dueAt,
          actorId: 'owner',
        },
      });
    const overdue = new Date('2020-01-01T00:00:00.000Z');
    const future = new Date('2099-01-01T00:00:00.000Z');
    for (const amount of amounts.overdue) await charge(amount, overdue);
    if (amounts.partial) {
      const item = await charge(amounts.partial.amount, overdue);
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          kind: 'PAYMENT',
          amountMinor: amounts.partial.paid,
          settlesChargeId: item.id,
          actorId: 'owner',
        },
      });
      if (amounts.partial.dishonoured) {
        await db.pharmacyKhataEvent.create({
          data: {
            organizationId,
            branchId: branch.id,
            familyAccountId: family.id,
            kind: 'DISHONOURED_CHEQUE',
            amountMinor: amounts.partial.dishonoured,
            settlesChargeId: item.id,
            actorId: 'owner',
          },
        });
      }
    }
    if (amounts.unlinked?.paid) {
      const item = await charge(amounts.unlinked.paid, overdue);
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          kind: 'PAYMENT',
          amountMinor: amounts.unlinked.paid,
          settlesChargeId: item.id,
          actorId: 'owner',
        },
      });
    }
    if (amounts.unlinked?.dishonoured) {
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          kind: 'DISHONOURED_CHEQUE',
          amountMinor: amounts.unlinked.dishonoured,
          actorId: 'owner',
        },
      });
    }
    if (amounts.future) await charge(amounts.future, future);
    return { organizationId, branchId: branch.id, familyAccountId: family.id };
  });
}

beforeAll(async () => {
  if (!url) return;
  withTenantDb = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  readCommandCentre = (await import('./reports')).readPharmacyOwnerCommandCentre;
});

suite('owner command centre Khata aging under forced PostgreSQL RLS', () => {
  it('uses a login role that cannot bypass forced tenant RLS', async () => {
    const roles = await withTenantDb(orgA, (db) =>
      db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
        'SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname=current_user'
      )
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: true }]);
  });

  it('caps unlinked dishonours per family without borrowing another family payment', async () => {
    const bounced = await createFixture(orgA, `report-cap-${suffix}`, {
      overdue: [],
      unlinked: { paid: 100, dishonoured: 400 },
    });
    await createFixture(
      orgA,
      `report-paid-${suffix}`,
      {
        overdue: [],
        unlinked: { paid: 1000, dishonoured: 0 },
      },
      bounced.branchId
    );
    await createFixture(
      orgA,
      `report-no-payment-${suffix}`,
      {
        overdue: [],
        unlinked: { paid: 0, dishonoured: 500 },
      },
      bounced.branchId
    );
    const result = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [bounced.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );
    expect(result.metrics.khataAgingMinor).toBe(100);
  });

  it('does not reinstate the same payment through linked and unlinked dishonours', async () => {
    const fixture = await createFixture(orgA, `report-mixed-${suffix}`, {
      overdue: [],
      partial: { amount: 500, paid: 500, dishonoured: 200 },
      unlinked: { paid: 0, dishonoured: 1000 },
    });
    const result = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [fixture.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );
    expect(result.metrics.khataAgingMinor).toBe(500);
  });

  it.each([40, 100, 150])(
    'nets a repayment of %i against unlinked dishonoured debt within the same family',
    async (repaid) => {
      const fixture = await createFixture(orgA, `report-repaid-${repaid}-${suffix}`, {
        overdue: [],
        unlinked: { paid: 100, dishonoured: 100 },
      });
      await createFixture(
        orgA,
        `report-unpaid-${repaid}-${suffix}`,
        { overdue: [70] },
        fixture.branchId
      );
      const observed = await withTenantDb(orgA, async (db) => {
        await db.$queryRawUnsafe(
          "SELECT set_config('app.current_branch_id', $1, true)",
          fixture.branchId
        );
        const charge = await db.pharmacyKhataEvent.findFirstOrThrow({
          where: { familyAccountId: fixture.familyAccountId, kind: 'CHARGE' },
        });
        await db.pharmacyKhataEvent.create({
          data: {
            organizationId: orgA,
            branchId: fixture.branchId,
            familyAccountId: fixture.familyAccountId,
            kind: 'PAYMENT',
            amountMinor: repaid,
            settlesChargeId: charge.id,
            actorId: 'owner',
          },
        });
        const { readKhataBalance } = await import('./family-khata');
        const balance = await readKhataBalance(
          db,
          { organizationId: orgA, branchId: fixture.branchId, actorId: 'owner' },
          fixture.familyAccountId
        );
        const report = await readCommandCentre(db, {
          branchIds: [fixture.branchId],
          from: '2026-01-01',
          to: '2026-01-01',
        });
        return { balance, aging: report.metrics.khataAgingMinor };
      });
      expect(observed).toEqual({ balance: 100 - repaid, aging: 70 + Math.max(100 - repaid, 0) });
    }
  );

  it('does not consume another family credit to clear an unlinked dishonour', async () => {
    const fixture = await createFixture(orgA, `report-owing-${suffix}`, {
      overdue: [],
      unlinked: { paid: 100, dishonoured: 100 },
    });
    await createFixture(
      orgA,
      `report-credit-${suffix}`,
      { overdue: [], partial: { amount: 100, paid: 200 } },
      fixture.branchId
    );
    const report = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [fixture.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );
    expect(report.metrics.khataAgingMinor).toBe(100);
  });

  it('aggregates real open items across authorized branches without leaking a supplied foreign branch', async () => {
    const first = await createFixture(orgA, `report-a1-${suffix}`, {
      overdue: [1_500_000_000],
      partial: { amount: 1_500_000_000, paid: 250_000_000 },
      future: 700,
    });
    const second = await createFixture(orgA, `report-a2-${suffix}`, {
      overdue: [100],
      partial: { amount: 400, paid: 400, dishonoured: 400 },
      unlinked: { paid: 300, dishonoured: 300 },
    });
    const third = await createFixture(orgA, `report-a3-${suffix}`, {
      overdue: [],
      partial: { amount: 500, paid: 500, dishonoured: 200 },
    });
    const fullyBounced = await createFixture(orgA, `report-a4-${suffix}`, {
      overdue: [],
      partial: { amount: 100, paid: 100, dishonoured: 100 },
    });
    const overDishonoured = await createFixture(orgA, `report-a5-${suffix}`, {
      overdue: [],
      partial: { amount: 100, paid: 50, dishonoured: 500 },
      unlinked: { paid: 40, dishonoured: 400 },
    });
    const foreign = await createFixture(orgB, `report-b-${suffix}`, {
      overdue: [2_000_000_000],
    });

    const result = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [
          first.branchId,
          second.branchId,
          third.branchId,
          fullyBounced.branchId,
          foreign.branchId,
        ],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );

    const fullyBouncedResult = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [fullyBounced.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );
    const partiallyBounced = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [third.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );
    const overDishonouredResult = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [overDishonoured.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );

    // Includes unpaid + partially paid overdue charges and adds full and partial bounced-cheque
    // debt back in.
    // Excludes the future charge and foreign organization's charge. The total is also deliberately
    // above PostgreSQL INTEGER_MAX.
    expect(result.metrics.khataAgingMinor).toBe(2_750_001_100);
    expect(fullyBouncedResult.metrics.khataAgingMinor).toBe(100);
    expect(partiallyBounced.metrics.khataAgingMinor).toBe(200);
    // Malformed legacy/imported rows cannot reinstate more than the associated prior payment.
    expect(overDishonouredResult.metrics.khataAgingMinor).toBe(140);
  });
});
