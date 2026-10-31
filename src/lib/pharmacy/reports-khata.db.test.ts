import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

// Exercise the real router, tenant facade, readers and RLS; grant the report capabilities
// without requiring an unrelated user/role fixture or audit writer.
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));
vi.mock('@/server/audit', () => ({
  isAuditExcludedPath: () => true,
  ipFromHeaders: () => null,
  recordTrpcAudit: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
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
  amounts: { overdue: number[]; partial?: { amount: number; paid: number }; future?: number }
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
    }
    if (amounts.future) await charge(amounts.future, future);
    return { organizationId, branchId: branch.id };
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  readCommandCentre = (await import('./reports')).readPharmacyOwnerCommandCentre;
});

suite('owner command centre Khata aging under forced PostgreSQL RLS', () => {
  it('preserves branch context for comparison calls through the RSC tenant facade', async () => {
    const organizationId = `org_compare_khata_${suffix}`;
    const first = await createFixture(organizationId, `compare-a1-${suffix}`, {
      overdue: [1_500_000_000],
      partial: { amount: 1_500_000_000, paid: 250_000_000 },
      future: 700,
    });
    const second = await createFixture(organizationId, `compare-a2-${suffix}`, {
      overdue: [100],
      partial: { amount: 400, paid: 400 },
    });
    const foreign = await createFixture(`org_compare_foreign_${suffix}`, `compare-b-${suffix}`, {
      overdue: [2_000_000_000],
    });
    const inactive = await createFixture(organizationId, `compare-inactive-${suffix}`, {
      overdue: [999],
    });
    await withTenantDb(organizationId, (db) =>
      db.pharmacyBranch.update({ where: { id: inactive.branchId }, data: { active: false } })
    );

    const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { pharmacyReportsRouter } = await import('@/server/routers/pharmacy-reports');
    const api = pharmacyReportsRouter.createCaller({
      db: createTenantDb(organizationId),
      entitlements: { organizationId, enabledModules: ['pharmacy-reports'], modules: [] },
      session: {
        expires: 'later',
        user: { id: 'owner', role: 'ADMIN', status: 'ACTIVE', organizationId },
      },
      organization: { id: organizationId },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);
    const result = await api.branchComparison({ from: '2026-01-01', to: '2026-01-01' });

    expect(result.rows.map((row) => [row.branchId, row.khataAgingMinor])).toEqual([
      [first.branchId, 2_750_000_000],
      [second.branchId, 100],
    ]);
    expect(
      result.rows.some((row) => [foreign.branchId, inactive.branchId].includes(row.branchId))
    ).toBe(false);
  }, 30_000);

  it('aggregates real open items across authorized branches without leaking a supplied foreign branch', async () => {
    const first = await createFixture(orgA, `report-a1-${suffix}`, {
      overdue: [1_500_000_000],
      partial: { amount: 1_500_000_000, paid: 250_000_000 },
      future: 700,
    });
    const second = await createFixture(orgA, `report-a2-${suffix}`, {
      overdue: [100],
      partial: { amount: 400, paid: 400 },
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

    // Includes unpaid + partially paid overdue charges in both tenant branches. Excludes the
    // fully paid charge, future charge, and foreign organization's charge. The total is also
    // deliberately above PostgreSQL INTEGER_MAX.
    expect(result.metrics.khataAgingMinor).toBe(2_750_000_100);
  });
});
