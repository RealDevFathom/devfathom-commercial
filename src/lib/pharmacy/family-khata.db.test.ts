import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const originalTimezone = process.env.TZ;
process.env.TZ = 'UTC';
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
  approverId: string;
};
let a: Fixture, sibling: Fixture, foreign: Fixture;
async function fixture(
  organizationId: string,
  label: string,
  dueAt = new Date()
): Promise<Fixture> {
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
    await db.organizationDepartment.upsert({
      where: { organizationId_key: { organizationId, key: 'operations' } },
      update: {},
      create: { organizationId, key: 'operations', name: 'Operations' },
    });
    const ownerRole = await db.organizationRole.upsert({
      where: { organizationId_key: { organizationId, key: 'owner' } },
      update: { isSystem: true },
      create: { organizationId, key: 'owner', name: 'Owner', isSystem: true },
    });
    // The owner template's grant: approval authority is re-checked through the ABAC engine.
    await db.organizationRolePermission.upsert({
      where: {
        organizationRoleId_capability: {
          organizationRoleId: ownerRole.id,
          capability: 'pharmacy:*',
        },
      },
      update: { effect: 'ALLOW' },
      create: { organizationId, organizationRoleId: ownerRole.id, capability: 'pharmacy:*' },
    });
    const approver = await db.user.upsert({
      where: { organizationId_email: { organizationId, email: `${organizationId}@owner.test` } },
      update: { status: 'ACTIVE', organizationRoleId: ownerRole.id },
      create: {
        organizationId,
        email: `${organizationId}@owner.test`,
        name: 'Khata owner',
        department: 'operations',
        title: 'Owner',
        status: 'ACTIVE',
        organizationRoleId: ownerRole.id,
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
    // Owner/manager approvers must be assigned to the branch whose charge they approve.
    await db.pharmacyBranchAssignment.create({
      data: { organizationId, branchId: branch.id, userId: approver.id },
    });
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
          dueAt,
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
      approverId: approver.id,
    };
  });
}
async function issueApproval(db: ScopedDb, scope: Fixture, amountMinor: number, ageMs = 0) {
  const id = randomUUID();
  // Mirrors the endpoint: the approved final limit is the balance at approval + amount.
  const approvedLimitMinor =
    (await khata.readKhataBalance(db, scope, scope.familyAccountId)) + amountMinor;
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_khata_override_approvals
       (id, "organizationId", "branchId", "approverId", "saleId", "familyAccountId", "amountMinor",
        "approvedLimitMinor", reason, "createdAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $9, 'Approved exception',
       NOW() - ($8::int * INTERVAL '1 millisecond'),
       NOW() - ($8::int * INTERVAL '1 millisecond') + INTERVAL '5 minutes')`,
    id,
    scope.organizationId,
    scope.branchId,
    scope.approverId,
    scope.saleId,
    scope.familyAccountId,
    amountMinor,
    ageMs,
    approvedLimitMinor
  );
  return id;
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
afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
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
      await khata.authorizeKhataCharge(db, a, { ...a, amountMinor: 400 }, {});
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
      inScope(a, async (db) =>
        khata.authorizeKhataCharge(
          db,
          a,
          { ...a, amountMinor: 401, ownerOverride: true, overrideReason: 'Approved exception' },
          { approvalId: await issueApproval(db, a, 401, 301_000) }
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
        await khata.authorizeKhataCharge(db, a, { ...a, amountMinor: 300 }, {});
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
    const approvalId = await inScope(a, (db) => issueApproval(db, a, 200));
    const override = {
      ...a,
      amountMinor: 200,
      ownerOverride: true,
      overrideReason: 'Approved exception',
    };
    await inScope(a, (db) => khata.authorizeKhataCharge(db, a, override, { approvalId }));
    // Single-use: the evidence is consumed and its consumption cannot be undone.
    const [evidence] = await inScope(a, (db) =>
      db.$queryRawUnsafe<Array<{ consumedAt: Date | null }>>(
        'SELECT "consumedAt" FROM pharmacy_khata_override_approvals WHERE id=$1',
        approvalId
      )
    );
    expect(evidence?.consumedAt).toBeInstanceOf(Date);
    await expect(
      inScope(a, (db) =>
        db.$executeRawUnsafe(
          'UPDATE pharmacy_khata_override_approvals SET "consumedAt"=NULL WHERE id=$1',
          approvalId
        )
      )
    ).rejects.toThrow();
    await expect(
      inScope(a, (db) =>
        db.$executeRawUnsafe(
          'DELETE FROM pharmacy_khata_override_approvals WHERE id=$1',
          approvalId
        )
      )
    ).rejects.toThrow();
    const decision = await inScope(a, (db) =>
      db.pharmacyKhataLimitDecision.findFirst({ where: { familyAccountId: a.familyAccountId } })
    );
    expect(decision).toMatchObject({
      appliedLimitMinor: 1100,
      ownerActorId: a.approverId,
      reasons: expect.objectContaining({ ownerAuthorizedByUserId: a.approverId, approvalId }),
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
  it('re-checks approver DENY overrides at consumption and ignores expired ones', async () => {
    const override = {
      ...sibling,
      amountMinor: 500,
      ownerOverride: true,
      overrideReason: 'Approved exception',
    };
    const deny = (expiresAt: Date | null) => ({
      organizationId: orgA,
      userId: sibling.approverId,
      capability: 'pharmacy:*',
      effect: 'DENY' as const,
      reason: 'Investigation',
      expiresAt,
    });
    const approvalId = await inScope(sibling, (db) => issueApproval(db, sibling, 500));
    // A DENY added after issuance refuses consumption; the whole tender rolls back.
    await expect(
      inScope(sibling, async (db) => {
        await db.userPermissionOverride.create({ data: deny(null) });
        return khata.authorizeKhataCharge(db, sibling, override, { approvalId });
      })
    ).rejects.toMatchObject({ reason: 'OWNER_ACTION_REQUIRED' });
    await inScope(sibling, async (db) => {
      expect(await db.userPermissionOverride.count({ where: { userId: sibling.approverId } })).toBe(
        0
      );
      await db.userPermissionOverride.create({ data: deny(new Date(Date.now() - 60_000)) });
      await khata.authorizeKhataCharge(db, sibling, override, { approvalId });
    });
    const decision = await inScope(sibling, (db) =>
      db.pharmacyKhataLimitDecision.findFirst({
        where: { familyAccountId: sibling.familyAccountId },
      })
    );
    expect(decision).toMatchObject({
      appliedLimitMinor: 1100,
      ownerActorId: sibling.approverId,
      reasons: expect.objectContaining({ approvalId }),
    });
  });
});

suite('khata reminder PostgreSQL balance and idempotency', () => {
  it('keeps cross-branch payments scoped and derives overdue dates from outstanding charges', async () => {
    expect(process.env.TZ).toBe('UTC');
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    const { readDueKhataAccounts } = await import('./whatsapp/khata-reminders');
    const scope = await fixture(orgA, 'Reminder', new Date('2026-11-01T00:00:00.000Z'));
    const now = new Date('2026-10-21T08:00:00.000Z');
    const oldest = new Date('2026-10-01T00:00:00.000Z');
    const next = new Date('2026-10-10T00:00:00.000Z');
    const charges = await inScope(scope, async (db) => {
      return db.pharmacyKhataEvent.createManyAndReturn({
        data: [oldest, next, new Date('2026-11-01T00:00:00.000Z')].map((dueAt) => ({
          organizationId: orgA,
          branchId: scope.branchId,
          familyAccountId: scope.familyAccountId,
          kind: 'CHARGE' as const,
          memberId: scope.memberId,
          dueAt,
          amountMinor: 20_000,
          actorId: scope.actorId,
        })),
      });
    });
    const charge = charges.find((row) => row.dueAt?.getTime() === oldest.getTime())!;
    // A payment physically written at a different branch cannot bypass the
    // account/charge composite FKs, even under a platform scan context.
    await expect(
      withPlatformDb((db) =>
        db.pharmacyKhataEvent.create({
          data: {
            organizationId: orgA,
            branchId: sibling.branchId,
            familyAccountId: scope.familyAccountId,
            kind: 'PAYMENT',
            amountMinor: 20_000,
            settlesChargeId: charge.id,
            actorId: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    expect(
      await inScope(scope, (db) => khata.readKhataBalance(db, scope, scope.familyAccountId))
    ).toBe(60_600);
    const beforePayment = await withPlatformDb((db) => readDueKhataAccounts(db, orgA, now, 1));
    expect(beforePayment[0].oldestOverdueAt.toISOString()).toBe(oldest.toISOString());
    await expect(
      inScope(scope, (db) =>
        db.pharmacyKhataEvent.create({
          data: {
            organizationId: orgA,
            branchId: scope.branchId,
            familyAccountId: scope.familyAccountId,
            kind: 'PAYMENT',
            amountMinor: 20_000,
            actorId: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    await inScope(scope, (db) =>
      db.pharmacyKhataEvent.create({
        data: {
          organizationId: orgA,
          branchId: scope.branchId,
          familyAccountId: scope.familyAccountId,
          kind: 'PAYMENT',
          amountMinor: 20_000,
          settlesChargeId: charge.id,
          actorId: scope.actorId,
        },
      })
    );
    const statement = await inScope(scope, (db) =>
      khata.readSaleKhataStatement(db, scope, scope.saleId, scope.familyAccountId)
    );
    expect(statement.account.balanceMinor).toBe(40_600);
    // Existing accounts have earlier overdue charges but balances below the
    // floor. They must not consume the single available result slot.
    const rows = await withPlatformDb((db) => readDueKhataAccounts(db, orgA, now, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].familyAccountId).toBe(scope.familyAccountId);
    expect(Number(rows[0].balanceMinor)).toBe(statement.account.balanceMinor);
    expect(rows[0].oldestOverdueAt.toISOString()).toBe(next.toISOString());
    const second = charges.find((row) => row.dueAt?.getTime() === next.getTime())!;
    await inScope(scope, (db) =>
      db.pharmacyKhataEvent.create({
        data: {
          organizationId: orgA,
          branchId: scope.branchId,
          familyAccountId: scope.familyAccountId,
          kind: 'PAYMENT',
          amountMinor: 19_999,
          settlesChargeId: second.id,
          actorId: scope.actorId,
        },
      })
    );
    const partial = await withPlatformDb((db) => readDueKhataAccounts(db, orgA, now, 1));
    expect(partial[0].oldestOverdueAt.toISOString()).toBe(next.toISOString());
    expect(Number(partial[0].balanceMinor)).toBe(20_601);
    await inScope(scope, (db) =>
      db.pharmacyKhataEvent.create({
        data: {
          organizationId: orgA,
          branchId: scope.branchId,
          familyAccountId: scope.familyAccountId,
          kind: 'PAYMENT',
          amountMinor: 1,
          settlesChargeId: second.id,
          actorId: scope.actorId,
        },
      })
    );
    const settled = await withPlatformDb((db) => readDueKhataAccounts(db, orgA, now, 100));
    expect(settled.find((row) => row.familyAccountId === scope.familyAccountId)).toBeUndefined();
  });

  it('filters balances before the 500-account cap', async () => {
    const scope = await fixture(orgB, 'Cap');
    await inScope(scope, async (db) => {
      const account = await db.pharmacyFamilyAccount.findFirstOrThrow({
        where: { id: scope.familyAccountId },
      });
      const accounts = Array.from({ length: 501 }, (_, index) => ({
        id: `cap_${suffix}_${index}`,
        organizationId: orgB,
        branchId: scope.branchId,
        payerCustomerId: account.payerCustomerId,
        displayName: 'Cap family',
      }));
      await db.pharmacyFamilyAccount.createMany({ data: accounts });
      await db.pharmacyFamilyMember.createMany({
        data: accounts.map((account) => ({
          id: `member_${account.id}`,
          organizationId: orgB,
          branchId: scope.branchId,
          familyAccountId: account.id,
          customerId: account.payerCustomerId,
        })),
      });
      await db.pharmacyKhataEvent.createMany({
        data: accounts.map((account, index) => ({
          organizationId: orgB,
          branchId: scope.branchId,
          familyAccountId: account.id,
          memberId: `member_${account.id}`,
          kind: 'CHARGE' as const,
          amountMinor: index === 500 ? 20_000 : 1,
          dueAt: new Date(index === 500 ? '2026-10-10T00:00:00Z' : '2026-10-01T00:00:00Z'),
          actorId: scope.actorId,
        })),
      });
    });
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    const { readDueKhataAccounts } = await import('./whatsapp/khata-reminders');
    const rows = await withPlatformDb((db) =>
      readDueKhataAccounts(db, orgB, new Date('2026-10-21T08:00:00Z'), 500)
    );
    expect(rows.map((row) => row.familyAccountId)).toEqual([`cap_${suffix}_500`]);
  });

  it('allows only one concurrent customer/day claim, even with different account keys', async () => {
    const { claimMessageLogInTransaction } = await import('./whatsapp/message-log');
    const customerId = await inScope(
      sibling,
      async (db) =>
        (
          await db.pharmacyFamilyAccount.findFirstOrThrow({
            where: { id: sibling.familyAccountId },
          })
        ).payerCustomerId
    );
    const claim = (account: string, day: string) =>
      tenant(orgA, (db) =>
        claimMessageLogInTransaction(db, {
          organizationId: orgA,
          customerId,
          kind: 'KHATA_REMINDER',
          direction: 'OUTBOUND',
          status: 'PENDING',
          dedupeKey: `test:${suffix}:${account}`,
          customerDayKey: `khata:${customerId}:${day}`,
        })
      );
    const claims = await Promise.all([claim('a', '2026-10-21'), claim('b', '2026-10-21')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claim('c', '2026-10-22')).toBeTruthy();
  });
});
