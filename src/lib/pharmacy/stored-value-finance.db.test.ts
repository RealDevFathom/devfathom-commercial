/** NEW-head bridge integration cases. No database without explicit opt-in.
 * Use only ChiefQA's fresh, throwaway, restricted/NOBYPASS/nonowner FORCE-RLS DB.
 * Fixtures are synthetic and retained; no deletion, reset or production access.
 * This suite does NOT prove a counter endpoint, identity gates or payment-provider settlement.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PharmacyStoredValueCommand, StoredValuePostingScope } from './stored-value-finance';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const enabled = Boolean(url && process.env.PHARMACY_STORED_VALUE_BRIDGE_TEST_DB === '1');
if (enabled) process.env.DATABASE_URL = url;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeDb = enabled ? describe : describe.skip;
let scoped: typeof import('@/lib/tenancy/scoped-db');
let bridge: typeof import('./stored-value-finance');
const unique = (name: string) => `w603_${name}_${randomBytes(8).toString('hex')}`;
type Fixture = {
  scope: StoredValuePostingScope;
  walletId: string;
  cashId: string;
  otherBranchId: string;
};

async function fixture(): Promise<Fixture> {
  const org = unique('org');
  const branch = unique('branch');
  const otherBranchId = unique('unassigned');
  const actor = unique('actor');
  const customer = unique('customer');
  const walletId = unique('wallet');
  const cashId = unique('cash');
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",currency,"createdAt","updatedAt")
     VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PKR',now(),now())`,
      org
    )
  );
  await scoped.withTenantDb(org, async (db) => {
    // Active tenant-owned parent BEFORE the user composite department FK.
    await db.organizationDepartment.create({
      data: { organizationId: org, key: 'LEADERSHIP', name: 'Leadership', active: true },
    });
    await db.user.create({
      data: {
        id: actor,
        organizationId: org,
        name: actor,
        email: `${actor}@invalid.example`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Synthetic bridge tester',
        status: 'ACTIVE',
      },
    });
    for (const id of [branch, otherBranchId])
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId: org,
          code: id,
          name: id,
          addressLine: 'Synthetic',
          city: 'Synthetic',
          provinceCode: 'PB',
          active: true,
        },
      });
    await db.pharmacyBranchAssignment.create({
      data: { organizationId: org, branchId: branch, userId: actor, active: true },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId: org, displayName: 'Synthetic bridge patient' },
    });
    await db.pharmacyCustomer.create({
      data: {
        id: customer,
        organizationId: org,
        patientId: patient.id,
        displayName: 'Synthetic bridge customer',
        active: true,
      },
    });
    await db.storedValueAccount.create({
      data: {
        id: walletId,
        organizationId: org,
        customerId: customer,
        kind: 'CUSTOMER_LIABILITY',
        currency: 'PKR',
        balanceMinor: 0,
      },
    });
    await db.storedValueAccount.create({
      data: {
        id: cashId,
        organizationId: org,
        kind: 'CASH_CLEARING',
        currency: 'PKR',
        balanceMinor: 0,
      },
    });
    await db.pharmacyWalletSettings.create({
      data: { organizationId: org, allowUnusedRefund: true },
    });
  });
  return {
    scope: { organizationId: org, branchId: branch, actorId: actor, currency: 'PKR' },
    walletId,
    cashId,
    otherBranchId,
  };
}
function topup(f: Fixture, amountMinor = 1000, extra = {}): PharmacyStoredValueCommand {
  const id = unique('topup');
  return {
    kind: 'TOP_UP',
    journalId: id,
    idempotencyKey: id,
    accountId: f.walletId,
    counterpartyAccountId: f.cashId,
    amountMinor,
    tender: 'CASH',
    ...extra,
  };
}
function refund(
  f: Fixture,
  originalJournalId: string,
  amountMinor = 100
): PharmacyStoredValueCommand {
  const id = unique('refund');
  return {
    kind: 'REFUND',
    journalId: id,
    idempotencyKey: id,
    accountId: f.walletId,
    counterpartyAccountId: f.cashId,
    amountMinor,
    originalJournalId,
  };
}
async function snapshot(f: Fixture) {
  return scoped.withTenantDb(
    f.scope.organizationId,
    async (db) => ({
      accounts: await db.storedValueAccount.findMany({
        where: { organizationId: f.scope.organizationId },
        orderBy: { id: 'asc' },
      }),
      journals: await db.storedValueJournal.findMany({
        where: { organizationId: f.scope.organizationId },
        orderBy: { id: 'asc' },
      }),
      entries: await db.storedValueEntry.findMany({
        where: { organizationId: f.scope.organizationId },
        orderBy: { id: 'asc' },
      }),
      canonical: await db.financeJournalEntry.findMany({
        where: { organizationId: f.scope.organizationId },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
    }),
    { userId: f.scope.actorId }
  );
}

beforeAll(async () => {
  if (!enabled) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  const role = await import('@/lib/testing/rls-role-guard');
  await role.assertRlsEnforcingRole(scoped.withPlatformDb);
  // Also refuse an owning role or absent/unforced RLS, before any fixture writes.
  const tables = await scoped.withPlatformDb((db) =>
    db.$queryRawUnsafe<
      Array<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owns: boolean;
      }>
    >(
      `SELECT relname,relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owns
     FROM pg_class WHERE oid IN (
       'stored_value_accounts'::regclass,'stored_value_journals'::regclass,'stored_value_entries'::regclass,
       'finance_journal_entries'::regclass,'finance_journal_lines'::regclass)`
    )
  );
  if (
    tables.length !== 5 ||
    tables.some((row) => row.owns || !row.relrowsecurity || !row.relforcerowsecurity)
  )
    throw new Error('BRIDGE_TEST_REQUIRES_NONOWNER_FORCE_RLS');
  bridge = await import('./stored-value-finance');
}, 120_000);

describeDb('funded wallet bridge — real PostgreSQL, explicit fresh DB only', () => {
  it('atomically posts one balanced canonical source and two signed wallet legs', async () => {
    const f = await fixture();
    const cmd = topup(f);
    await bridge.postPharmacyStoredValue(f.scope, cmd);
    const rows = await snapshot(f);
    expect(rows.accounts.find((row) => row.id === f.walletId)?.balanceMinor).toBe(1000);
    expect(rows.journals).toHaveLength(1);
    expect(rows.journals[0]).toMatchObject({
      id: cmd.journalId,
      currency: 'PKR',
      branchId: f.scope.branchId,
    });
    expect(rows.entries.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([-1000, 1000]);
    expect(rows.canonical).toHaveLength(1);
    expect(rows.canonical[0]).toMatchObject({
      sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL',
      sourceId: cmd.journalId,
      currency: 'PKR',
      branchId: f.scope.branchId,
    });
    expect(
      rows.canonical[0].lines.map((row) => [row.accountCode, row.side, row.amountMinor]).sort()
    ).toEqual([
      ['CASH', 'DEBIT', 1000],
      ['CUSTOMER_WALLET_LIABILITY', 'CREDIT', 1000],
    ]);
  });
  it('exact retry is no-op and conflicting retry cannot mutate either ledger/cache', async () => {
    const f = await fixture();
    const cmd = topup(f);
    await bridge.postPharmacyStoredValue(f.scope, cmd);
    const before = await snapshot(f);
    expect(await bridge.postPharmacyStoredValue(f.scope, cmd)).toMatchObject({ replayed: true });
    await expect(
      bridge.postPharmacyStoredValue(f.scope, { ...cmd, amountMinor: 1001 })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot(f)).toEqual(before);
  });
  it('second canonical-line failure rolls back the first line, header, subledger and balance', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      scoped.withTenantDb(
        f.scope.organizationId,
        async (db) => {
          let lines = 0;
          const failing = new Proxy(db, {
            get(target, prop) {
              if (prop !== 'financeJournalLine') return Reflect.get(target, prop);
              return new Proxy(target.financeJournalLine, {
                get(delegate, operation) {
                  if (operation !== 'create') return Reflect.get(delegate, operation);
                  return (...args: unknown[]) => {
                    if (++lines === 2) throw new Error('INJECTED_SECOND_CANONICAL_LINE');
                    return Reflect.apply(delegate.create, delegate, args);
                  };
                },
              });
            },
          });
          return bridge.postPharmacyStoredValueInTransaction(failing, f.scope, topup(f));
        },
        { userId: f.scope.actorId }
      )
    ).rejects.toThrow('INJECTED_SECOND_CANONICAL_LINE');
    expect(await snapshot(f)).toEqual(before);
  });
  it('caller failure after both journals rolls back the entire owning transaction', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      scoped.withTenantDb(
        f.scope.organizationId,
        async (db) => {
          await bridge.postPharmacyStoredValueInTransaction(db, f.scope, topup(f));
          throw new Error('INJECTED_OWNING_EVENT_FAILURE');
        },
        { userId: f.scope.actorId }
      )
    ).rejects.toThrow('INJECTED_OWNING_EVENT_FAILURE');
    expect(await snapshot(f)).toEqual(before);
  });
  it('concurrent retries commit exactly one deposit/source entry', async () => {
    const f = await fixture();
    const cmd = topup(f);
    const results = await Promise.all([
      bridge.postPharmacyStoredValue(f.scope, cmd),
      bridge.postPharmacyStoredValue(f.scope, cmd),
    ]);
    expect(results.filter((row) => row.replayed)).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((row) => row.id === f.walletId)?.balanceMinor).toBe(1000);
    expect(rows.journals).toHaveLength(1);
    expect(rows.entries).toHaveLength(2);
    expect(rows.canonical).toHaveLength(1);
  });
  it('competing refunds cannot overdraw or reuse an original deposit', async () => {
    const f = await fixture();
    const original = topup(f);
    await bridge.postPharmacyStoredValue(f.scope, original);
    const results = await Promise.allSettled([
      bridge.postPharmacyStoredValue(f.scope, refund(f, original.journalId, 700)),
      bridge.postPharmacyStoredValue(f.scope, refund(f, original.journalId, 700)),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((row) => row.id === f.walletId)?.balanceMinor).toBe(300);
    expect(rows.journals).toHaveLength(2);
    expect(rows.canonical).toHaveLength(2);
  });
  it('actual branch assignment is required even for ADMIN; denial has no financial effects', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      bridge.postPharmacyStoredValue({ ...f.scope, branchId: f.otherBranchId }, topup(f))
    ).rejects.toThrow('WALLET_SCOPE_DENIED');
    expect(await snapshot(f)).toEqual(before);
  });
  it('canonical DENY defeats ADMIN and leaves both ledgers/cache unchanged', async () => {
    const f = await fixture();
    await scoped.withTenantDb(
      f.scope.organizationId,
      (db) =>
        db.userPermissionOverride.create({
          data: {
            organizationId: f.scope.organizationId,
            userId: f.scope.actorId,
            capability: 'pharmacy:wallet-topup',
            effect: 'DENY',
            reason: 'Synthetic explicit deny',
          },
        }),
      { userId: f.scope.actorId }
    );
    const before = await snapshot(f);
    await expect(bridge.postPharmacyStoredValue(f.scope, topup(f))).rejects.toThrow(
      'WALLET_PERMISSION_DENIED'
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it('foreign-tenant wallet is refused and actual RLS hides foreign events', async () => {
    const a = await fixture();
    const b = await fixture();
    await bridge.postPharmacyStoredValue(b.scope, topup(b));
    const beforeA = await snapshot(a);
    const beforeB = await snapshot(b);
    await expect(
      bridge.postPharmacyStoredValue(a.scope, topup(a, 100, { accountId: b.walletId }))
    ).rejects.toThrow('WALLET_ACCOUNT_SCOPE');
    expect(await snapshot(a)).toEqual(beforeA);
    expect(await snapshot(b)).toEqual(beforeB);
    await scoped.withTenantDb(
      a.scope.organizationId,
      async (db) => {
        expect(
          await db.storedValueJournal.findMany({
            where: { organizationId: b.scope.organizationId },
          })
        ).toEqual([]);
        expect(
          await db.financeJournalEntry.findMany({
            where: { organizationId: b.scope.organizationId },
          })
        ).toEqual([]);
      },
      { userId: a.scope.actorId }
    );
  });
});
