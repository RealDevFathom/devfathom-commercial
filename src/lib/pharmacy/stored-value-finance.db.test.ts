/** NEW-head bridge integration cases. No database without explicit opt-in.
 * Use only ChiefQA's fresh, throwaway, restricted/NOBYPASS/nonowner FORCE-RLS DB.
 * Fixtures are synthetic and retained; no deletion, reset or production access.
 * This suite does NOT prove a counter endpoint, identity gates or payment-provider settlement.
 */
import { randomBytes } from 'node:crypto';
import {
  accountsTestDatabase,
  assertAccountsTestDatabase,
} from '@/lib/testing/accounts-test-database';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PharmacyStoredValueCommand, StoredValuePostingScope } from './stored-value-finance';

const enabled = process.env.PHARMACY_STORED_VALUE_BRIDGE_TEST_DB === '1';
if (enabled && process.env.PHARMACY_STORED_VALUE_BRIDGE_DISPOSABLE_DB !== '1')
  throw new Error('BRIDGE_TEST_REQUIRES_DISPOSABLE_DB_ATTESTATION_AND_URL');
const target = enabled ? accountsTestDatabase(process.env) : undefined;
if (target) process.env.DATABASE_URL = target.url;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeDb = enabled ? describe : describe.skip;
let scoped: typeof import('@/lib/tenancy/scoped-db');
let bridge: typeof import('./stored-value-finance');
const unique = (name: string) => `w603_${name}_${randomBytes(8).toString('hex')}`;
type Fixture = {
  scope: StoredValuePostingScope;
  walletId: string;
  cashId: string;
  salesId: string;
  customerId: string;
  otherBranchId: string;
};

async function fixture(
  options: { grants?: string[]; currency?: 'PKR' | 'USD' } = {}
): Promise<Fixture> {
  const org = unique('org');
  const branch = unique('branch');
  const otherBranchId = unique('unassigned');
  const actor = unique('actor');
  const customer = unique('customer');
  const walletId = unique('wallet');
  const cashId = unique('cash');
  const salesId = unique('clearing');
  const roleId = unique('role');
  const currency = options.currency ?? 'PKR';
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",currency,"createdAt","updatedAt")
     VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2::"Currency",now(),now())`,
      org,
      currency
    )
  );
  await scoped.withTenantDb(org, async (db) => {
    // Active tenant-owned parent BEFORE the user composite department FK.
    await db.organizationDepartment.create({
      data: { organizationId: org, key: 'LEADERSHIP', name: 'Leadership', active: true },
    });
    await db.organizationRole.create({
      data: { id: roleId, organizationId: org, key: roleId, name: 'Synthetic exact bridge grants' },
    });
    for (const capability of options.grants ?? ['pharmacy:wallet-topup', 'pharmacy:counter'])
      await db.organizationRolePermission.create({
        data: { organizationId: org, organizationRoleId: roleId, capability, effect: 'ALLOW' },
      });
    await db.user.create({
      data: {
        id: actor,
        organizationId: org,
        name: actor,
        email: `${actor}@invalid.example`,
        role: 'ADMIN', // Label intentionally insufficient without canonical grants.
        organizationRoleId: roleId,
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
        currency,
        balanceMinor: 0,
      },
    });
    await db.storedValueAccount.create({
      data: {
        id: cashId,
        organizationId: org,
        kind: 'CASH_CLEARING',
        currency,
        balanceMinor: 0,
      },
    });
    await db.storedValueAccount.create({
      data: { id: salesId, organizationId: org, kind: 'SALES_CLEARING', currency, balanceMinor: 0 },
    });
    await db.pharmacyWalletSettings.create({
      data: { organizationId: org, allowUnusedRefund: true },
    });
  });
  return {
    scope: { organizationId: org, branchId: branch, actorId: actor, currency },
    walletId,
    cashId,
    salesId,
    customerId: customer,
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
async function sale(f: Fixture, totalMinor = 2000, tenderMinor = 0) {
  return scoped.withTenantDb(
    f.scope.organizationId,
    async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: f.scope.organizationId,
          productName: unique('synthetic'),
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          presentations: {
            create: { organizationId: f.scope.organizationId, presentation: 'Synthetic strip' },
          },
        },
        include: { presentations: true },
      });
      const presentationId = medicine.presentations[0]!.id;
      const pack = await db.packLevel.create({
        data: {
          organizationId: f.scope.organizationId,
          presentationId,
          versionGroupId: unique('version'),
          version: 1,
          level: 'STRIP',
          unitsPerParent: 1,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        },
      });
      const row = await db.pharmacySale.create({
        data: {
          organizationId: f.scope.organizationId,
          branchId: f.scope.branchId,
          createdByUserId: f.scope.actorId,
          customerId: f.customerId,
        },
      });
      await db.pharmacySaleLine.create({
        data: {
          organizationId: f.scope.organizationId,
          branchId: f.scope.branchId,
          saleId: row.id,
          medicineId: medicine.id,
          presentationId,
          packLevelId: pack.id,
          saleUnit: 'PACK',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          canonicalUnits: 1,
          unitPriceMinor: totalMinor,
          proRataCeilingMinor: totalMinor,
          unitCostMinor: 0,
          discountMinor: 0,
          idempotencyKey: unique('line'),
        },
      });
      if (tenderMinor) {
        const deviceId = unique('device');
        const drawer = await db.pharmacyDrawerSession.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            deviceId,
            businessDate: new Date('2026-10-25T00:00:00Z'),
            openingFloatMinor: 0,
            openedByActorId: f.scope.actorId,
          },
        });
        await db.pharmacyTender.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            saleId: row.id,
            type: 'CASH',
            amountMinor: tenderMinor,
            drawerSessionId: drawer.id,
            cashReceivedMinor: tenderMinor,
            changeGivenMinor: 0,
            businessDate: new Date('2026-10-25T00:00:00Z'),
            actorId: f.scope.actorId,
            deviceId,
          },
        });
      }
      return row.id;
    },
    { userId: f.scope.actorId }
  );
}
function spend(
  f: Fixture,
  saleId: string,
  amountMinor = 400,
  extra = {}
): PharmacyStoredValueCommand {
  const id = unique('spend');
  return {
    kind: 'SPEND',
    journalId: id,
    idempotencyKey: id,
    accountId: f.walletId,
    counterpartyAccountId: f.salesId,
    saleId,
    amountMinor,
    ...extra,
  };
}
/** Two real, simultaneously open pg transactions; not a serialized JS model. */
async function compete(f: Fixture, commands: PharmacyStoredValueCommand[]) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Promise.allSettled(
    commands.map((command) =>
      scoped.withTenantDb(
        f.scope.organizationId,
        async (db) => {
          if (++arrived === commands.length) release();
          await ready;
          return bridge.postPharmacyStoredValueInTransaction(db, f.scope, command);
        },
        { userId: f.scope.actorId }
      )
    )
  );
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
      tenders: await db.pharmacyTender.findMany({
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
  await assertAccountsTestDatabase(scoped.withPlatformDb, target!);
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
        ownerMember: boolean;
      }>
    >(
      `SELECT relname,relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owns, pg_has_role(current_user,relowner,'MEMBER') AS "ownerMember"
     FROM pg_class WHERE oid IN (
       'stored_value_accounts'::regclass,'stored_value_journals'::regclass,'stored_value_entries'::regclass,
       'finance_journal_entries'::regclass,'finance_journal_lines'::regclass)`
    )
  );
  if (
    tables.length !== 5 ||
    tables.some(
      (row) => row.owns || row.ownerMember || !row.relrowsecurity || !row.relforcerowsecurity
    )
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
  it.each(['TOP_UP', 'SPEND'] as const)(
    '%s second canonical-line failure rolls back first line, header, subledger and balance',
    async (kind) => {
      const f = await fixture();
      if (kind === 'SPEND') await bridge.postPharmacyStoredValue(f.scope, topup(f));
      const cmd = kind === 'SPEND' ? spend(f, await sale(f)) : topup(f);
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
            return bridge.postPharmacyStoredValueInTransaction(failing, f.scope, cmd);
          },
          { userId: f.scope.actorId }
        )
      ).rejects.toThrow('INJECTED_SECOND_CANONICAL_LINE');
      expect(await snapshot(f)).toEqual(before);
    }
  );
  it.each(['TOP_UP', 'SPEND'] as const)(
    '%s caller failure after both journals rolls back entire owning transaction',
    async (kind) => {
      const f = await fixture();
      if (kind === 'SPEND') await bridge.postPharmacyStoredValue(f.scope, topup(f));
      const cmd = kind === 'SPEND' ? spend(f, await sale(f)) : topup(f);
      const before = await snapshot(f);
      await expect(
        scoped.withTenantDb(
          f.scope.organizationId,
          async (db) => {
            await bridge.postPharmacyStoredValueInTransaction(db, f.scope, cmd);
            throw new Error('INJECTED_OWNING_EVENT_FAILURE');
          },
          { userId: f.scope.actorId }
        )
      ).rejects.toThrow('INJECTED_OWNING_EVENT_FAILURE');
      expect(await snapshot(f)).toEqual(before);
    }
  );
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
  it('all competing unused TOP_UP refunds reject even with the stored setting enabled', async () => {
    const f = await fixture();
    const original = topup(f);
    await bridge.postPharmacyStoredValue(f.scope, original);
    const before = await snapshot(f);
    const results = await Promise.allSettled([
      bridge.postPharmacyStoredValue(f.scope, refund(f, original.journalId, 700)),
      bridge.postPharmacyStoredValue(f.scope, refund(f, original.journalId, 700)),
    ]);
    expect(
      results.every(
        (r) => r.status === 'rejected' && r.reason.message === 'WALLET_REFUND_NOT_APPROVED'
      )
    ).toBe(true);
    expect(await snapshot(f)).toEqual(before);
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
  it.each(['CASH', 'BANK_TRANSFER'] as const)(
    'granted %s TOP_UP uses the original asset and exact PKR',
    async (tender) => {
      const f = await fixture();
      await bridge.postPharmacyStoredValue(f.scope, topup(f, 1000, { tender }));
      const rows = await snapshot(f);
      expect(rows.canonical[0].currency).toBe('PKR');
      expect(
        rows.canonical[0].lines.map((l) => [l.accountCode, l.side, l.amountMinor]).sort()
      ).toEqual(
        [
          [tender === 'CASH' ? 'CASH' : 'BANK', 'DEBIT', 1000],
          ['CUSTOMER_WALLET_LIABILITY', 'CREDIT', 1000],
        ].sort()
      );
    }
  );
  it('persists PKR SPEND against clearing exactly once, not revenue/AR/tender', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const cmd = spend(f, await sale(f), 400);
    await bridge.postPharmacyStoredValue(f.scope, cmd);
    const rows = await snapshot(f);
    expect(rows.accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(600);
    const event = rows.journals.find((j) => j.id === cmd.journalId)!;
    expect(event).toMatchObject({
      kind: 'SPEND',
      saleId: cmd.kind === 'SPEND' ? cmd.saleId : '',
      currency: 'PKR',
    });
    expect(
      rows.entries
        .filter((e) => e.journalId === cmd.journalId)
        .map((e) => [e.accountId, e.amountMinor])
        .sort()
    ).toEqual(
      [
        [f.walletId, -400],
        [f.salesId, 400],
      ].sort()
    );
    const canonical = rows.canonical.find((j) => j.sourceId === cmd.journalId)!;
    expect(canonical.currency).toBe('PKR');
    expect(canonical.lines.map((l) => [l.accountCode, l.side, l.amountMinor]).sort()).toEqual([
      ['CUSTOMER_WALLET_LIABILITY', 'DEBIT', 400],
      ['SALES_CLEARING', 'CREDIT', 400],
    ]);
    expect(rows.tenders).toEqual([]);
    expect(rows.canonical).toHaveLength(2);
  });
  it('SPEND exact retry after later debit is no-op; amount/sale/key conflicts cannot mutate evidence', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const saleId = await sale(f);
    const cmd = spend(f, saleId, 400);
    await bridge.postPharmacyStoredValue(f.scope, cmd);
    await bridge.postPharmacyStoredValue(f.scope, spend(f, saleId, 200));
    const before = await snapshot(f);
    expect(await bridge.postPharmacyStoredValue(f.scope, cmd)).toMatchObject({ replayed: true });
    for (const changes of [
      { amountMinor: 401 },
      { saleId: await sale(f) },
      { journalId: unique('conflict') },
    ])
      await expect(
        bridge.postPharmacyStoredValue(f.scope, {
          ...cmd,
          ...changes,
        } as PharmacyStoredValueCommand)
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot(f)).toEqual(before);
  });
  it('concurrent SPEND retries commit one event and one clearing credit', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const cmd = spend(f, await sale(f));
    const results = await compete(f, [cmd, cmd]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.replayed)).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(600);
    expect(rows.journals).toHaveLength(2);
    expect(rows.entries).toHaveLength(4);
    expect(rows.canonical).toHaveLength(2);
  });
  it('competing SPEND across different sales cannot overdraw a shared wallet', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const results = await compete(f, [spend(f, await sale(f), 700), spend(f, await sale(f), 700)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason.message === 'INSUFFICIENT_BALANCE')
    ).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(300);
    expect(rows.journals).toHaveLength(2);
    expect(rows.canonical).toHaveLength(2);
  });
  it('sale cap includes existing tender and earlier persisted SPEND', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f, 2000));
    const saleId = await sale(f, 1000, 300);
    await bridge.postPharmacyStoredValue(f.scope, spend(f, saleId, 500));
    const before = await snapshot(f);
    await expect(bridge.postPharmacyStoredValue(f.scope, spend(f, saleId, 201))).rejects.toThrow(
      'WALLET_SALE_ALREADY_FUNDED'
    );
    expect(await snapshot(f)).toEqual(before);
    await bridge.postPharmacyStoredValue(f.scope, spend(f, saleId, 200));
    expect((await snapshot(f)).accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(1300);
  });
  it('competing events cannot overfund the same sale even with ample wallet balance', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f, 2000));
    const saleId = await sale(f, 1000);
    const results = await compete(f, [spend(f, saleId, 600), spend(f, saleId, 600)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === 'rejected' && r.reason.message === 'WALLET_SALE_ALREADY_FUNDED'
      )
    ).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(1400);
    expect(rows.journals).toHaveLength(2);
    expect(rows.canonical).toHaveLength(2);
  });
  it('SPEND versus unapproved refund cannot create a payout or extra canonical source', async () => {
    const f = await fixture();
    const original = topup(f);
    await bridge.postPharmacyStoredValue(f.scope, original);
    const results = await compete(f, [
      spend(f, await sale(f), 400),
      refund(f, original.journalId, 700),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === 'rejected' && r.reason.message === 'WALLET_REFUND_NOT_APPROVED'
      )
    ).toHaveLength(1);
    const rows = await snapshot(f);
    expect(rows.accounts.find((a) => a.id === f.walletId)?.balanceMinor).toBe(600);
    expect(rows.journals.map((j) => j.kind).sort()).toEqual(['SPEND', 'TOP_UP']);
    expect(rows.canonical).toHaveLength(2);
  });
  it('ADMIN without canonical ALLOW cannot TOP_UP or SPEND', async () => {
    const f = await fixture({ grants: [] });
    const saleId = await sale(f);
    const before = await snapshot(f);
    for (const cmd of [topup(f), spend(f, saleId)])
      await expect(bridge.postPharmacyStoredValue(f.scope, cmd)).rejects.toThrow(
        'WALLET_PERMISSION_DENIED'
      );
    expect(await snapshot(f)).toEqual(before);
  });
  it('SPEND canonical DENY wins over role ALLOW', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const saleId = await sale(f);
    await scoped.withTenantDb(
      f.scope.organizationId,
      (db) =>
        db.userPermissionOverride.create({
          data: {
            organizationId: f.scope.organizationId,
            userId: f.scope.actorId,
            capability: 'pharmacy:counter',
            effect: 'DENY',
            reason: 'Synthetic explicit deny',
          },
        }),
      { userId: f.scope.actorId }
    );
    const before = await snapshot(f);
    await expect(bridge.postPharmacyStoredValue(f.scope, spend(f, saleId))).rejects.toThrow(
      'WALLET_PERMISSION_DENIED'
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it('refuses USD SPEND even when tenant, wallet and clearing all agree on USD', async () => {
    const f = await fixture({ currency: 'USD' });
    const before = await snapshot(f);
    await expect(bridge.postPharmacyStoredValue(f.scope, spend(f, await sale(f)))).rejects.toThrow(
      'WALLET_CURRENCY_MISMATCH'
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it('refuses account currency mismatch without partial financial effects', async () => {
    const f = await fixture();
    await scoped.withTenantDb(
      f.scope.organizationId,
      (db) =>
        db.storedValueAccount.update({
          where: { id: f.cashId },
          data: { currency: 'USD' },
        }),
      { userId: f.scope.actorId }
    );
    const before = await snapshot(f);
    await expect(bridge.postPharmacyStoredValue(f.scope, topup(f))).rejects.toThrow(
      'WALLET_CURRENCY_MISMATCH'
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(['REFUND', 'EXPIRY', 'ADJUSTMENT'] as const)(
    'unsupported %s has no effect at either callable boundary',
    async (kind) => {
      const f = await fixture();
      const before = await snapshot(f);
      const cmd = { ...refund(f, unique('original')), kind } as PharmacyStoredValueCommand;
      const reason = kind === 'REFUND' ? 'WALLET_REFUND_NOT_APPROVED' : 'WALLET_UNSUPPORTED_KIND';
      await expect(bridge.postPharmacyStoredValue(f.scope, cmd)).rejects.toThrow(reason);
      await expect(
        scoped.withTenantDb(
          f.scope.organizationId,
          (db) => bridge.postPharmacyStoredValueInTransaction(db, f.scope, cmd),
          { userId: f.scope.actorId }
        )
      ).rejects.toThrow(reason);
      expect(await snapshot(f)).toEqual(before);
    }
  );
  it('SPEND cannot use a foreign tenant account, another branch sale or another customer sale', async () => {
    const f = await fixture();
    const foreign = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const saleId = await sale(f);
    const branchSale = await sale(f);
    const customerSale = await sale(f);
    await scoped.withTenantDb(
      f.scope.organizationId,
      async (db) => {
        await db.pharmacySale.update({
          where: { id: branchSale },
          data: { branchId: f.otherBranchId },
        });
        const patient = await db.pharmacyPatient.create({
          data: { organizationId: f.scope.organizationId, displayName: 'Synthetic other patient' },
        });
        const other = await db.pharmacyCustomer.create({
          data: {
            organizationId: f.scope.organizationId,
            patientId: patient.id,
            displayName: 'Synthetic other customer',
            active: true,
          },
        });
        await db.pharmacySale.update({
          where: { id: customerSale },
          data: { customerId: other.id },
        });
      },
      { userId: f.scope.actorId }
    );
    const before = await snapshot(f);
    for (const [cmd, error] of [
      [spend(f, saleId, 100, { accountId: foreign.walletId }), 'WALLET_ACCOUNT_SCOPE'],
      [spend(f, branchSale), 'WALLET_SALE_SCOPE'],
      [spend(f, customerSale), 'WALLET_SALE_SCOPE'],
    ] as const)
      await expect(bridge.postPharmacyStoredValue(f.scope, cmd)).rejects.toThrow(error);
    expect(await snapshot(f)).toEqual(before);
  });
  it('same-transaction caller rolls back actual tender writes if bridge refuses sale cap', async () => {
    const f = await fixture();
    await bridge.postPharmacyStoredValue(f.scope, topup(f));
    const saleId = await sale(f, 1000);
    const before = await snapshot(f);
    await expect(
      scoped.withTenantDb(
        f.scope.organizationId,
        async (db) => {
          const deviceId = unique('device');
          const drawer = await db.pharmacyDrawerSession.create({
            data: {
              organizationId: f.scope.organizationId,
              branchId: f.scope.branchId,
              deviceId,
              businessDate: new Date('2026-10-25T00:00:00Z'),
              openingFloatMinor: 0,
              openedByActorId: f.scope.actorId,
            },
          });
          await db.pharmacyTender.create({
            data: {
              organizationId: f.scope.organizationId,
              branchId: f.scope.branchId,
              saleId,
              type: 'CASH',
              amountMinor: 700,
              drawerSessionId: drawer.id,
              cashReceivedMinor: 700,
              changeGivenMinor: 0,
              businessDate: new Date('2026-10-25T00:00:00Z'),
              actorId: f.scope.actorId,
              deviceId,
            },
          });
          await bridge.postPharmacyStoredValueInTransaction(db, f.scope, spend(f, saleId, 400));
        },
        { userId: f.scope.actorId }
      )
    ).rejects.toThrow('WALLET_SALE_ALREADY_FUNDED');
    expect(await snapshot(f)).toEqual(before);
  });
});

describeDb('owned-clearing writer regression — real DB, no acceptance of invalid history', () => {
  const cases = ['TOP_UP CASH', 'TOP_UP BANK_TRANSFER', 'SPEND SALES_CLEARING'] as const;
  async function commandFor(f: Fixture, operation: (typeof cases)[number]) {
    if (operation === 'SPEND SALES_CLEARING') {
      await bridge.postPharmacyStoredValue(f.scope, topup(f));
      return spend(f, await sale(f));
    }
    return topup(f, 1000, { tender: operation === 'TOP_UP CASH' ? 'CASH' : 'BANK_TRANSFER' });
  }
  async function primitive(f: Fixture, cmd: PharmacyStoredValueCommand) {
    const { postStoredValueJournal } = await import('@/lib/stored-value/ledger');
    return scoped.withTenantDb(
      f.scope.organizationId,
      (db) =>
        postStoredValueJournal(db, {
          ...f.scope,
          ...cmd,
          direction: cmd.kind === 'SPEND' ? 'DEBIT' : 'CREDIT',
          tender: cmd.kind === 'TOP_UP' ? cmd.tender : undefined,
        }),
      { userId: f.scope.actorId }
    );
  }
  for (const replay of [false, true]) {
    for (const boundary of ['bridge', 'primitive'] as const) {
      it.each(cases)(
        `%s ${boundary} refuses owned clearing, replay=${replay}, no effects`,
        async (operation) => {
          const f = await fixture();
          const cmd = await commandFor(f, operation);
          const post = () =>
            boundary === 'bridge'
              ? bridge.postPharmacyStoredValue(f.scope, cmd)
              : primitive(f, cmd);
          if (replay) await post();
          await scoped.withTenantDb(f.scope.organizationId, (db) =>
            db.storedValueAccount.update({
              where: { id: cmd.counterpartyAccountId },
              data: { customerId: f.customerId },
            })
          );
          const before = await snapshot(f);
          await expect(post()).rejects.toThrow(
            boundary === 'bridge' ? 'WALLET_ACCOUNT_SCOPE' : 'INVALID_ACCOUNT'
          );
          expect(await snapshot(f)).toEqual(before);
        }
      );
    }
  }
  it.each(cases)(
    '%s primitive accepts NULL clearing and retries without new effects',
    async (operation) => {
      const f = await fixture();
      const cmd = await commandFor(f, operation);
      const account = await scoped.withTenantDb(f.scope.organizationId, (db) =>
        db.storedValueAccount.findUniqueOrThrow({
          where: { id: cmd.counterpartyAccountId },
        })
      );
      expect(account.customerId).toBeNull();
      await expect(primitive(f, cmd)).resolves.toMatchObject({ replayed: false });
      const before = await snapshot(f);
      await expect(primitive(f, cmd)).resolves.toMatchObject({
        replayed: true,
        balanceDeltaMinor: 0,
      });
      expect(await snapshot(f)).toEqual(before);
    }
  );
});
