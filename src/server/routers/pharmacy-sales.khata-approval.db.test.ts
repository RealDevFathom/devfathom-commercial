/**
 * #313 against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role. The pharmacy system roles are
 * persisted from the role templates the way provisioning creates them, and ABAC reads
 * those rows: a standard Manager and an Owner may approve a Khata charge past the family
 * credit limit with a reason, the tenant ADMIN may too, and a Cashier or a Manager with an
 * explicit DENY may not. Skipped unless TEST_DATABASE_URL names a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});
// Settlement (journal, receipt numbering) is outside this authorization test. The router
// still reads the real idempotency evidence and writes the real Khata charge and audit.
vi.mock('@/lib/pharmacy/settlement', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pharmacy/settlement')>(
    '@/lib/pharmacy/settlement'
  );
  let tenders = 0;
  return {
    ...actual,
    applyPharmacyTender: vi.fn(async () => ({
      tenderId: `tender_k313_${Date.now()}_${++tenders}`,
      settled: false,
      receiptNumber: null,
      remainingMinor: 1,
      replayed: false,
    })),
  };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_k313_${suffix}`,
  branch: `br_k313_${suffix}`,
  owner: `user_k313_owner_${suffix}`,
  manager: `user_k313_manager_${suffix}`,
  deniedManager: `user_k313_denied_${suffix}`,
  cashier: `user_k313_cashier_${suffix}`,
  admin: `user_k313_admin_${suffix}`,
};
type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE' };
const people = {
  owner: { id: ids.owner, role: 'EMPLOYEE' },
  manager: { id: ids.manager, role: 'EMPLOYEE' },
  deniedManager: { id: ids.deniedManager, role: 'EMPLOYEE' },
  cashier: { id: ids.cashier, role: 'EMPLOYEE' },
  admin: { id: ids.admin, role: 'ADMIN' },
} satisfies Record<string, Person>;
type Bill = { saleId: string; familyAccountId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

function caller(db: unknown, person: Person, passwordAuthenticatedAt = Date.now()) {
  const context = {
    db,
    entitlements: {
      organizationId: ids.org,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: person.id,
        role: person.role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: ids.org,
        passwordAuthenticatedAt,
      },
    },
    organization: { id: ids.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return { api: pharmacySalesRouter.createCaller(context as never), context };
}

function tender(bill: Bill, amountMinor: number, overrideReason?: string) {
  return {
    branchId: ids.branch,
    saleId: bill.saleId,
    deviceId: 'device-k313',
    businessDate: new Date('2026-10-22T00:00:00.000Z'),
    type: 'KHATA' as const,
    amountMinor,
    idempotencyKey: `k313-${randomUUID()}`,
    familyAccountId: bill.familyAccountId,
    ownerOverride: true,
    ...(overrideReason === undefined ? {} : { overrideReason }),
  };
}

/** A sale whose customer pays from a family account with a 1,000 limit and no balance. */
async function khataBill(label: string): Promise<Bill> {
  return withTenantDb(ids.org, async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", ids.branch);
    const patient = await tx.pharmacyPatient.create({
      data: { organizationId: ids.org, displayName: `Patient ${label}` },
    });
    const customer = await tx.pharmacyCustomer.create({
      data: { organizationId: ids.org, patientId: patient.id, displayName: `Customer ${label}` },
    });
    const family = await tx.pharmacyFamilyAccount.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        payerCustomerId: customer.id,
        displayName: `Family ${label}`,
        creditLimitMinor: 1000,
      },
    });
    await tx.pharmacyFamilyMember.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        familyAccountId: family.id,
        customerId: customer.id,
      },
    });
    const sale = await tx.pharmacySale.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        customerId: customer.id,
        createdByUserId: ids.cashier,
      },
    });
    return { saleId: sale.id, familyAccountId: family.id };
  });
}

async function khataState(bill: Bill) {
  return withTenantDb(ids.org, async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", ids.branch);
    const [account, decisions, charges] = await Promise.all([
      tx.pharmacyFamilyAccount.findFirst({ where: { id: bill.familyAccountId } }),
      tx.pharmacyKhataLimitDecision.findMany({ where: { familyAccountId: bill.familyAccountId } }),
      tx.pharmacyKhataEvent.findMany({
        where: { familyAccountId: bill.familyAccountId, kind: 'CHARGE' },
      }),
    ]);
    return { limit: account!.creditLimitMinor, decisions, charges };
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

  await withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Khata 313', 'Khata 313', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    );
  });

  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'K313',
        name: 'Khata 313',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    // Exactly what organization provisioning persists for each system role template.
    const roleIds = new Map<string, string>();
    for (const template of PHARMACY_ROLE_TEMPLATES.filter((row) =>
      ['owner', 'manager', 'cashier'].includes(row.key)
    )) {
      const created = await tx.organizationRole.create({
        data: {
          organizationId: ids.org,
          key: template.key,
          name: template.name,
          isSystem: template.isSystem,
          permissions: {
            create: template.capabilities.map((capability) => ({
              organizationId: ids.org,
              capability,
              effect: 'ALLOW' as const,
            })),
          },
        },
      });
      roleIds.set(template.key, created.id);
    }
    const members: Array<{ id: string; role: 'ADMIN' | 'EMPLOYEE'; roleKey: string | null }> = [
      { id: ids.owner, role: 'EMPLOYEE', roleKey: 'owner' },
      { id: ids.manager, role: 'EMPLOYEE', roleKey: 'manager' },
      { id: ids.deniedManager, role: 'EMPLOYEE', roleKey: 'manager' },
      { id: ids.cashier, role: 'EMPLOYEE', roleKey: 'cashier' },
      { id: ids.admin, role: 'ADMIN', roleKey: null },
    ];
    for (const member of members) {
      await tx.user.create({
        data: {
          id: member.id,
          name: member.id,
          email: `${member.id}@example.test`,
          department: 'LEADERSHIP',
          title: member.roleKey ?? 'Administrator',
          role: member.role,
          organizationRoleId: member.roleKey ? roleIds.get(member.roleKey)! : null,
        },
      });
    }
    await tx.userPermissionOverride.create({
      data: {
        organizationId: ids.org,
        userId: ids.deniedManager,
        capability: 'pharmacy:manage',
        effect: 'DENY',
        reason: 'Suspended from approvals',
        createdById: ids.admin,
      },
    });
  });
}, 60_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('Khata over-limit approval against persisted pharmacy roles (#313)', () => {
  it('reads the persisted Manager role: no counter or dispense grant, yet it approves with a reason', async () => {
    const bill = await khataBill('manager');
    const audit = await withTenantDb(ids.org, async (tx) => {
      const { api, context } = caller(tx, people.manager);
      await expect(
        api.khataAccounts({ branchId: ids.branch, saleId: bill.saleId })
      ).resolves.toEqual([
        expect.objectContaining({
          id: bill.familyAccountId,
          creditLimitMinor: 1000,
          balanceMinor: 0,
        }),
      ]);
      await api.tender(tender(bill, 1500, '  Regular family, salary due Friday  '));
      return context.audit.detail;
    });
    const state = await khataState(bill);
    const approval = {
      saleId: bill.saleId,
      reason: 'Regular family, salary due Friday',
      approverBasis: 'pharmacy:manage',
      chargeAmountMinor: 1500,
      balanceBeforeMinor: 0,
      previousLimitMinor: 1000,
      approvedLimitMinor: 1500,
      amountOverLimitMinor: 500,
    };
    expect(state.limit).toBe(1500);
    expect(state.decisions).toEqual([
      expect.objectContaining({
        kind: 'OVERRIDDEN',
        appliedLimitMinor: 1500,
        ownerActorId: ids.manager,
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: ids.manager,
          overLimitCharge: approval,
        }),
      }),
    ]);
    expect(state.charges).toEqual([
      expect.objectContaining({ amountMinor: 1500, actorId: ids.manager }),
    ]);
    expect(audit).toMatchObject({
      action: 'khata_credit_limit_override',
      targetId: bill.familyAccountId,
      metadata: { approverId: ids.manager, decisionId: state.decisions[0]!.id, ...approval },
    });
  });

  it('lets the persisted Owner role and the tenant ADMIN approve', async () => {
    for (const [person, basis] of [
      [people.owner, 'pharmacy:manage'],
      [people.admin, 'tenant-admin'],
    ] as const) {
      const bill = await khataBill(person.id);
      await withTenantDb(ids.org, (tx) =>
        caller(tx, person).api.tender(tender(bill, 1200, 'Approved at the counter'))
      );
      const state = await khataState(bill);
      expect(state.limit).toBe(1200);
      expect(state.decisions).toEqual([
        expect.objectContaining({
          ownerActorId: person.id,
          reasons: expect.objectContaining({
            overLimitCharge: expect.objectContaining({
              approverBasis: basis,
              reason: 'Approved at the counter',
              amountOverLimitMinor: 200,
            }),
          }),
        }),
      ]);
    }
  });

  it('refuses a Cashier, a Manager with an explicit DENY, a blank reason and stale re-entry, writing nothing', async () => {
    const bill = await khataBill('refusals');
    const refusals: Array<[Person, ReturnType<typeof tender>, number, RegExp]> = [
      // The Cashier stays capped at the limit (whichever counter gate refuses first).
      [
        people.cashier,
        tender(bill, 1500, 'Cashier says fine'),
        Date.now(),
        /OWNER_ACTION_REQUIRED|Pharmacy counter permission required/,
      ],
      [
        people.deniedManager,
        tender(bill, 1500, 'Denied'),
        Date.now(),
        /Pharmacy counter permission required/,
      ],
      [people.manager, tender(bill, 1500), Date.now(), /OVERRIDE_REASON_REQUIRED/],
      [
        people.manager,
        tender(bill, 1500, 'Too late'),
        Date.now() - 6 * 60_000,
        /OWNER_ACTION_REQUIRED/,
      ],
    ];
    for (const [person, input, reauthenticatedAt, message] of refusals) {
      await expect(
        withTenantDb(ids.org, (tx) => caller(tx, person, reauthenticatedAt).api.tender(input))
      ).rejects.toMatchObject({ message: expect.stringMatching(message) });
    }
    expect(await khataState(bill)).toEqual({ limit: 1000, decisions: [], charges: [] });
  });
});
