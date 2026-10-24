/** #313 real ABAC -> scoped router -> settlement -> journal -> request audit, using synthetic data. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
// No authorization, database, settlement, or request-audit mocks.
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_k313_${suffix}`,
  branch: `br_k313_${suffix}`,
  branchB: `br_k313_other_${suffix}`,
  owner: `user_k313_owner_${suffix}`,
  manager: `user_k313_manager_${suffix}`,
  deniedManager: `user_k313_denied_${suffix}`,
  cashier: `user_k313_cashier_${suffix}`,
  admin: `user_k313_admin_${suffix}`,
  deniedAdmin: `user_k313_dadmin_${suffix}`,
  wildcardDeniedAdmin: `user_k313_wadmin_${suffix}`,
};
type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE' };
const people = {
  owner: { id: ids.owner, role: 'EMPLOYEE' },
  manager: { id: ids.manager, role: 'EMPLOYEE' },
  deniedManager: { id: ids.deniedManager, role: 'EMPLOYEE' },
  cashier: { id: ids.cashier, role: 'EMPLOYEE' },
  admin: { id: ids.admin, role: 'ADMIN' },
  deniedAdmin: { id: ids.deniedAdmin, role: 'ADMIN' },
  wildcardDeniedAdmin: { id: ids.wildcardDeniedAdmin, role: 'ADMIN' },
} satisfies Record<string, Person>;
type Bill = { saleId: string; familyAccountId: string; branchId: string };
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
  return pharmacySalesRouter.createCaller(context as never);
}
function tender(bill: Bill, amountMinor: number, overrideReason?: string) {
  return {
    branchId: bill.branchId,
    saleId: bill.saleId,
    deviceId: `device_k313_${suffix}`,
    businessDate: new Date('2026-10-23T00:00:00.000Z'),
    type: 'KHATA' as const,
    amountMinor,
    idempotencyKey: `khata_${randomUUID()}`,
    familyAccountId: bill.familyAccountId,
    ...(overrideReason === undefined ? {} : { overrideReason }),
  };
}
/** An actual OTC sale with an unpaid remainder avoids conflating this test with receipt completion. */
async function khataBill(label: string, branchId = ids.branch): Promise<Bill> {
  return withTenantDb(ids.org, async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchId);
    const patient = await tx.pharmacyPatient.create({
      data: { organizationId: ids.org, displayName: `Patient ${label}` },
    });
    const customer = await tx.pharmacyCustomer.create({
      data: { organizationId: ids.org, patientId: patient.id, displayName: `Customer ${label}` },
    });
    const family = await tx.pharmacyFamilyAccount.create({
      data: {
        organizationId: ids.org,
        branchId,
        payerCustomerId: customer.id,
        displayName: `Family ${label}`,
        creditLimitMinor: 1000,
      },
    });
    await tx.pharmacyFamilyMember.create({
      data: {
        organizationId: ids.org,
        branchId,
        familyAccountId: family.id,
        customerId: customer.id,
      },
    });
    const sale = await tx.pharmacySale.create({
      data: {
        organizationId: ids.org,
        branchId,
        customerId: customer.id,
        createdByUserId: ids.cashier,
      },
    });
    const medicine = await tx.medicine.create({
      data: {
        productName: `Khata OTC ${label} ${randomUUID()}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        rx: false,
        restricted: false,
        controlled: false,
        presentations: { create: { presentation: 'Tablet, ten per strip' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await tx.packLevel.create({
      data: {
        presentationId,
        versionGroupId: `khata-pack-${medicine.id}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await tx.pharmacySaleLine.create({
      data: {
        organizationId: ids.org,
        branchId,
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId,
        packLevelId: pack.id,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        canonicalUnits: 10,
        unitPriceMinor: 2000,
        proRataCeilingMinor: 2000,
        unitCostMinor: 100,
        idempotencyKey: randomUUID(),
      },
    });
    return { saleId: sale.id, familyAccountId: family.id, branchId };
  });
}
async function khataState(bill: Bill) {
  return withTenantDb(ids.org, async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", bill.branchId);
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
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = (await import('./pharmacy-sales')).pharmacySalesRouter;
  const { prisma } = await import('@/lib/db');
  disconnect = () => prisma.$disconnect();
  const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/pharmacy/staff');
  await withPlatformDb(
    {
      purpose: 'TEST',
      organizationId: ids.org,
      reason: '#313 synthetic Khata role and money integration',
      kind: 'SEED',
    },
    async (tx) => {
      const roles = await tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
      );
      expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await tx.organization.create({
        data: {
          id: ids.org,
          name: 'Khata synthetic pharmacy',
          slug: `khata-${suffix}`,
          seatLimit: 10,
          vertical: 'PHARMACY',
        },
      });
    }
  );
  await withTenantDb(ids.org, async (tx) => {
    for (const [id, code] of [
      [ids.branch, 'MAIN313'],
      [ids.branchB, 'OTHER313'],
    ]) {
      await tx.pharmacyBranch.create({
        data: {
          id,
          code,
          name: code,
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
    }
    // Exactly what organization provisioning persists for each system role template.
    const roleIds = new Map<string, string>();
    for (const template of PHARMACY_ROLE_TEMPLATES) {
      const role = await tx.organizationRole.create({
        data: {
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
      roleIds.set(template.key, role.id);
    }
    const members: Array<{ id: string; role: 'ADMIN' | 'EMPLOYEE'; roleKey: string | null }> = [
      { ...people.owner, roleKey: 'owner' },
      { ...people.manager, roleKey: 'manager' },
      { ...people.deniedManager, roleKey: 'manager' },
      { ...people.cashier, roleKey: 'cashier' },
      { ...people.admin, roleKey: null },
      { ...people.deniedAdmin, roleKey: null },
      { ...people.wildcardDeniedAdmin, roleKey: null },
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
      await tx.pharmacyBranchAssignment.create({
        data: { organizationId: ids.org, branchId: ids.branch, userId: member.id, active: true },
      });
    }
    for (const [userId, capability] of [
      [ids.deniedManager, 'pharmacy:manage'],
      [ids.deniedAdmin, 'pharmacy:manage'],
      [ids.wildcardDeniedAdmin, 'pharmacy:*'],
    ]) {
      await tx.userPermissionOverride.create({
        data: {
          organizationId: ids.org,
          userId,
          capability,
          effect: 'DENY',
          reason: 'Suspended from approvals',
          createdById: ids.admin,
        },
      });
    }
  });
}, 60_000);
afterEach(async () => {
  if (databaseUrl) await (await import('@/server/audit')).flushAuditWritesForTest();
});
afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase(
  'Khata Owner/Manager approval against persisted pharmacy roles and real money (#313)',
  () => {
    it('offers a standard Manager the family balance, then persists an approval and charge', async () => {
      const bill = await khataBill('manager');
      const accounts = await withTenantDb(ids.org, (tx) =>
        caller(tx, people.manager).khataAccounts({ branchId: ids.branch, saleId: bill.saleId })
      );
      expect(accounts).toEqual([
        expect.objectContaining({
          id: bill.familyAccountId,
          creditLimitMinor: 1000,
          balanceMinor: 0,
        }),
      ]);
      await withTenantDb(ids.org, (tx) =>
        caller(tx, people.manager).tender(
          tender(bill, 1500, '  Regular family, salary due Friday  ')
        )
      );
      const state = await khataState(bill);
      expect(state.limit).toBe(1500);
      expect(state.decisions).toEqual([
        expect.objectContaining({
          kind: 'OVERRIDDEN',
          appliedLimitMinor: 1500,
          ownerActorId: ids.manager,
          reasons: expect.objectContaining({
            ownerAuthorizedByUserId: ids.manager,
            overLimitCharge: expect.objectContaining({
              saleId: bill.saleId,
              reason: 'Regular family, salary due Friday',
              approverBasis: 'pharmacy:manage',
              chargeAmountMinor: 1500,
              balanceBeforeMinor: 0,
              previousLimitMinor: 1000,
              approvedLimitMinor: 1500,
              amountOverLimitMinor: 500,
            }),
          }),
        }),
      ]);
      expect(state.charges).toEqual([
        expect.objectContaining({ amountMinor: 1500, actorId: ids.manager }),
      ]);
    });
    it('lets the persisted Owner role and tenant ADMIN approve', async () => {
      for (const [person, basis] of [
        [people.owner, 'pharmacy:manage'],
        [people.admin, 'tenant-admin'],
      ] as const) {
        const bill = await khataBill(person.id);
        await withTenantDb(ids.org, (tx) =>
          caller(tx, person).tender(tender(bill, 1200, 'Approved at the counter'))
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
    it('refuses a Cashier, denied Manager, blank reason and stale re-entry without writing money', async () => {
      const bill = await khataBill('refusals');
      const refusals: Array<[Person, ReturnType<typeof tender>, number, RegExp]> = [
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
      for (const [person, input, at, message] of refusals) {
        await expect(
          withTenantDb(ids.org, (tx) => caller(tx, person, at).tender(input))
        ).rejects.toMatchObject({ message: expect.stringMatching(message) });
      }
      expect(await khataState(bill)).toEqual({ limit: 1000, decisions: [], charges: [] });
    });
    it('refuses manager access at another active branch and ADMIN exact/wildcard DENYs before any write', async () => {
      const cross = await khataBill('unassigned', ids.branchB);
      await expect(
        withTenantDb(ids.org, (tx) =>
          caller(tx, people.manager).khataAccounts({ branchId: ids.branchB, saleId: cross.saleId })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        withTenantDb(ids.org, (tx) =>
          caller(tx, people.manager).tender(tender(cross, 1500, 'Not assigned here'))
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await khataState(cross)).toEqual({ limit: 1000, decisions: [], charges: [] });
      const bill = await khataBill('admin-denied');
      for (const person of [people.deniedAdmin, people.wildcardDeniedAdmin]) {
        await expect(
          withTenantDb(ids.org, (tx) =>
            caller(tx, person).khataAccounts({ branchId: ids.branch, saleId: bill.saleId })
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          withTenantDb(ids.org, (tx) =>
            caller(tx, person).tender(tender(bill, 1500, 'Explicitly denied'))
          )
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await khataState(bill)).toEqual({ limit: 1000, decisions: [], charges: [] });
    });
    it('persists one real CREDIT tender, decision, charge, balanced journal and request audit on replay', async () => {
      const bill = await khataBill('real-replay');
      const input = tender(bill, 1500, 'Authorized once');
      const pay = () => withTenantDb(ids.org, (tx) => caller(tx, people.manager).tender(input));
      const first = await pay();
      expect(first).toMatchObject({ settled: false, remainingMinor: 500, replayed: false });
      expect(await pay()).toMatchObject({ tenderId: first.tenderId, replayed: true });
      const state = await khataState(bill);
      expect(state.charges).toHaveLength(1);
      expect(state.decisions).toHaveLength(1);
      await (await import('@/server/audit')).flushAuditWritesForTest();
      await withTenantDb(ids.org, async (tx) => {
        expect(await tx.pharmacyTender.findMany({ where: { saleId: bill.saleId } })).toEqual([
          expect.objectContaining({ id: first.tenderId, type: 'CREDIT', amountMinor: 1500 }),
        ]);
        const entries = await tx.financeJournalEntry.findMany({
          where: { sourceKind: 'PHARMACY_TENDER', sourceId: first.tenderId },
          include: { lines: true },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]!.lines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              accountCode: 'ACCOUNTS_RECEIVABLE',
              side: 'DEBIT',
              amountMinor: 1500,
            }),
            expect.objectContaining({
              accountCode: 'SALES_CLEARING',
              side: 'CREDIT',
              amountMinor: 1500,
            }),
          ])
        );
        const audits = await tx.auditLog.findMany({
          where: {
            action: 'khata_credit_limit_override',
            targetId: bill.familyAccountId,
            outcome: 'SUCCESS',
          },
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          actorId: ids.manager,
          metadata: expect.objectContaining({
            branchId: ids.branch,
            approverId: ids.manager,
            decisionId: state.decisions[0]!.id,
            reason: 'Authorized once',
          }),
        });
      });
    });
  }
);
