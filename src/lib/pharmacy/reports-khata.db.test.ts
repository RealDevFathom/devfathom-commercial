import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// CI supplies TEST_DATABASE_URL, while the focused acceptance command documents DATABASE_URL.
// Either must opt in explicitly because this test writes fixture rows.
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_report_khata_a_${suffix}`;
const orgB = `org_report_khata_b_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let readCommandCentre: typeof import('./reports').readPharmacyOwnerCommandCentre;

type KhataFixture = { organizationId: string; branchId: string };

async function createFixture(
  organizationId: string,
  label: string,
  amounts: {
    overdue: number[];
    partial?: { amount: number; paid: number; dishonoured?: number };
    unlinkedDishonoured?: number;
    future?: number;
  }
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
    const branch = await db.pharmacyBranch.create({
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
    if (amounts.unlinkedDishonoured) {
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId,
          branchId: branch.id,
          familyAccountId: family.id,
          kind: 'DISHONOURED_CHEQUE',
          amountMinor: amounts.unlinkedDishonoured,
          actorId: 'owner',
        },
      });
    }
    if (amounts.future) await charge(amounts.future, future);
    return { organizationId, branchId: branch.id };
  });
}

beforeAll(async () => {
  if (!url) return;
  withTenantDb = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  readCommandCentre = (await import('./reports')).readPharmacyOwnerCommandCentre;
});

suite('owner command centre Khata aging under forced PostgreSQL RLS', () => {
  it('aggregates real open items across authorized branches without leaking a supplied foreign branch', async () => {
    const first = await createFixture(orgA, `report-a1-${suffix}`, {
      overdue: [1_500_000_000],
      partial: { amount: 1_500_000_000, paid: 250_000_000 },
      future: 700,
    });
    const second = await createFixture(orgA, `report-a2-${suffix}`, {
      overdue: [100],
      partial: { amount: 400, paid: 400, dishonoured: 400 },
      unlinkedDishonoured: 300,
    });
    const foreign = await createFixture(orgB, `report-b-${suffix}`, {
      overdue: [2_000_000_000],
    });

    const result = await withTenantDb(orgA, (db) =>
      readCommandCentre(db, {
        branchIds: [first.branchId, second.branchId, foreign.branchId],
        from: '2026-01-01',
        to: '2026-01-01',
      })
    );

    // Includes unpaid + partially paid overdue charges and adds bounced-cheque debt back in.
    // Excludes the future charge and foreign organization's charge. The total is also deliberately
    // above PostgreSQL INTEGER_MAX.
    expect(result.metrics.khataAgingMinor).toBe(2_750_000_800);
  });
});
