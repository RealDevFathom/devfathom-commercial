import { randomBytes } from 'node:crypto';
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

suite('cash Khata collection PostgreSQL atomicity and replay', () => {
  it('posts concurrent retries once, reconciles the drawer, and replays after day close', async () => {
    const scope = await fixture(orgA, 'Cash');
    const { openPharmacyDrawer, closePharmacyDrawer, cutPharmacyDailyClose } =
      await import('./settlement');
    const businessDate = new Date('2026-10-29T00:00:00.000Z');
    const drawer = await inScope(scope, (db) =>
      openPharmacyDrawer(db, scope, {
        deviceId: 'cash_counter',
        businessDate,
        openingFloatMinor: 1000,
      })
    );
    const input = {
      familyAccountId: scope.familyAccountId,
      amountMinor: 250,
      occurredAt: new Date('2026-10-29T09:00:00.000Z'),
      drawerSessionId: drawer.id,
      deviceId: drawer.deviceId,
      idempotencyKey: `cash_${suffix}`,
    };
    const collect = () => inScope(scope, (db) => khata.settleFamilyKhata(db, scope, input));
    const results = await Promise.all([collect(), collect()]);
    expect(results[0]).toEqual(results[1]);
    await inScope(scope, async (db) => {
      expect(await khata.readKhataBalance(db, scope, scope.familyAccountId)).toBe(350);
      const payments = await db.pharmacyKhataEvent.findMany({
        where: { familyAccountId: scope.familyAccountId, kind: 'PAYMENT' },
      });
      expect(payments.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(250);
      expect(
        await db.pharmacyDrawerMovement.findMany({
          where: { drawerSessionId: drawer.id, kind: 'PAID_IN' },
        })
      ).toEqual([expect.objectContaining({ amountMinor: 250 })]);
      const [movement] = await db.pharmacyDrawerMovement.findMany({
        where: { drawerSessionId: drawer.id, kind: 'PAID_IN' },
      });
      const entries = await db.financeJournalEntry.findMany({
        where: { sourceKind: 'PHARMACY_KHATA_COLLECTION', branchId: scope.branchId },
        include: { lines: true },
      });
      expect(entries).toEqual([
        expect.objectContaining({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          sourceId: movement.id,
          idempotencyKey: `finance:PHARMACY_KHATA_COLLECTION:${movement.id}`,
        }),
      ]);
      expect(
        entries[0].lines
          .map((line) => [line.accountCode, line.side, line.amountMinor])
          .sort()
      ).toEqual([
        ['ACCOUNTS_RECEIVABLE', 'CREDIT', 250],
        ['CASH', 'DEBIT', 250],
      ]);
      expect(
        await closePharmacyDrawer(db, scope, {
          drawerSessionId: drawer.id,
          countedCashMinor: 1250,
        })
      ).toMatchObject({ expectedCashMinor: 1250, varianceMinor: 0 });
      await cutPharmacyDailyClose(db, scope, { businessDate });
    });
    expect(await collect()).toEqual(results[0]);
    await expect(
      inScope(scope, (db) => khata.settleFamilyKhata(db, scope, { ...input, amountMinor: 200 }))
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      inScope(scope, (db) =>
        khata.settleFamilyKhata(db, scope, { ...input, idempotencyKey: 'new_closed_collection' })
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    await expect(
      inScope(sibling, (db) => khata.settleFamilyKhata(db, sibling, input))
    ).rejects.toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
    await expect(
      inScope(foreign, (db) => khata.settleFamilyKhata(db, foreign, input))
    ).rejects.toMatchObject({ reason: 'ACCOUNT_NOT_FOUND' });
    expect(
      await inScope(scope, (db) => khata.readKhataBalance(db, scope, scope.familyAccountId))
    ).toBe(350);
    expect(
      await inScope(scope, (db) =>
        db.financeJournalEntry.count({
          where: { sourceKind: 'PHARMACY_KHATA_COLLECTION', branchId: scope.branchId },
        })
      )
    ).toBe(1);
  });

  it('rolls back payments, the drawer movement and the key when the transaction fails', async () => {
    const scope = await fixture(orgA, 'CashRollback');
    const { openPharmacyDrawer } = await import('./settlement');
    const drawer = await inScope(scope, (db) =>
      openPharmacyDrawer(db, scope, {
        deviceId: 'rollback_counter',
        businessDate: new Date('2026-10-29T00:00:00.000Z'),
        openingFloatMinor: 0,
      })
    );
    const input = {
      familyAccountId: scope.familyAccountId,
      amountMinor: 250,
      occurredAt: new Date('2026-10-29T09:00:00.000Z'),
      drawerSessionId: drawer.id,
      deviceId: drawer.deviceId,
      idempotencyKey: `rollback_${suffix}`,
    };
    await expect(
      inScope(scope, async (db) => {
        await khata.settleFamilyKhata(db, scope, input);
        // A database failure in the same request must undo every collection row.
        await db.$executeRawUnsafe('SELECT 1 / 0');
      })
    ).rejects.toThrow();
    await inScope(scope, async (db) => {
      expect(await khata.readKhataBalance(db, scope, scope.familyAccountId)).toBe(600);
      expect(await db.pharmacyDrawerMovement.count({ where: { drawerSessionId: drawer.id } })).toBe(
        0
      );
      expect(
        await db.pharmacyMoneyIdempotencyKey.count({ where: { key: input.idempotencyKey } })
      ).toBe(0);
      expect(
        await db.financeJournalEntry.count({
          where: { sourceKind: 'PHARMACY_KHATA_COLLECTION', branchId: scope.branchId },
        })
      ).toBe(0);
      await khata.settleFamilyKhata(db, scope, input);
      expect(await khata.readKhataBalance(db, scope, scope.familyAccountId)).toBe(350);
      expect(
        await db.financeJournalEntry.count({
          where: { sourceKind: 'PHARMACY_KHATA_COLLECTION', branchId: scope.branchId },
        })
      ).toBe(1);
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
