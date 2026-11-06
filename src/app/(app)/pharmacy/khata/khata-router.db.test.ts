import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
import { pharmacyKhataListRouter } from './khata-router';

const suffix = randomBytes(5).toString('hex');
const orgA = `dev730_a_${suffix}`;
const orgB = `dev730_b_${suffix}`;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let branchA: string, sibling: string, foreign: string;
async function fixture(org: string, label: string) {
  return tenant(
    org,
    async (db) => {
      await db.organization.upsert({
        where: { id: org },
        update: {},
        create: {
          id: org,
          slug: org,
          legalName: label,
          displayName: label,
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          currency: 'PKR',
        },
      });
      const branch = await db.pharmacyBranch.create({
        data: {
          organizationId: org,
          code: label,
          name: label,
          addressLine: '1 Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: label, phone: '03001234567' },
      });
      const payer = await db.pharmacyCustomer.create({
        data: { organizationId: org, patientId: patient.id, displayName: label },
      });
      const account = await db.pharmacyFamilyAccount.create({
        data: {
          organizationId: org,
          branchId: branch.id,
          payerCustomerId: payer.id,
          displayName: label,
          creditLimitMinor: 5000,
        },
      });
      const member = await db.pharmacyFamilyMember.create({
        data: {
          organizationId: org,
          branchId: branch.id,
          familyAccountId: account.id,
          customerId: payer.id,
        },
      });
      const charge = await db.pharmacyKhataEvent.create({
        data: {
          organizationId: org,
          branchId: branch.id,
          familyAccountId: account.id,
          kind: 'CHARGE',
          memberId: member.id,
          amountMinor: 3000,
          occurredAt: new Date('2026-01-01'),
          dueAt: new Date('2026-02-01'),
          actorId: 'owner',
        },
      });
      for (const [kind, amountMinor, occurredAt] of [
        ['PAYMENT', 700, '2026-02-01'],
        ['DISHONOURED_CHEQUE', 200, '2026-03-01'],
        ['PAYMENT', 100, '2026-04-01'],
      ] as const) {
        await db.pharmacyKhataEvent.create({
          data: {
            organizationId: org,
            branchId: branch.id,
            familyAccountId: account.id,
            kind,
            settlesChargeId: kind === 'PAYMENT' ? charge.id : undefined,
            amountMinor,
            occurredAt: new Date(occurredAt),
            actorId: 'owner',
          },
        });
      }
      return branch.id;
    },
    { skipDrain: true }
  );
}
function caller(db: ScopedDb, org: string) {
  return pharmacyKhataListRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'owner', organizationId: org, role: 'ADMIN', status: 'ACTIVE' },
    },
    entitlements: { organizationId: org, enabledModules: ['pharmacy-counter'], modules: [] },
    organization: { id: org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
beforeAll(async () => {
  if (!url) return;
  tenant = (await import('@/lib/tenancy/scoped-db')).withTenantDb;
  branchA = await fixture(orgA, 'Main');
  sibling = await fixture(orgA, 'Sibling');
  foreign = await fixture(orgB, 'Foreign');
}, 60000);
(url ? describe : describe.skip)('owner Khata list with restricted PostgreSQL', () => {
  it('reads full ledger, last payment and phone under a non-bypass role', async () => {
    await tenant(
      orgA,
      async (db) => {
        const role = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
        );
        expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const result = await caller(db, orgA).accounts({ branchId: branchA });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          displayName: 'Main',
          phone: '03001234567',
          balanceMinor: 2400,
          creditLimitMinor: 5000,
          lastPayment: { amountMinor: 100, occurredAt: new Date('2026-04-01') },
        });
      },
      { skipDrain: true }
    );
  });
  it('separates sibling branches and rejects a foreign branch', async () => {
    await tenant(
      orgA,
      async (db) => {
        expect(
          (await caller(db, orgA).accounts({ branchId: sibling })).rows.map((r) => r.displayName)
        ).toEqual(['Sibling']);
        expect(
          (await db.pharmacyFamilyAccount.findMany({ select: { displayName: true } })).map(
            (r) => r.displayName
          )
        ).toEqual(['Sibling']);
        await expect(caller(db, orgA).accounts({ branchId: foreign })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      },
      { skipDrain: true }
    );
  });
});
