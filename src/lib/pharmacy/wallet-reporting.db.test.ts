/**
 * Accounts FOUNDATION reporting regressions against migrated PostgreSQL.
 * Opt in ONLY on QA's fresh synthetic, socket-only disposable database:
 * PHARMACY_WALLET_REPORTING_TEST_DB=1 and
 * PHARMACY_WALLET_REPORTING_DISPOSABLE_DB=1, with
 * M8_TEST_RUNTIME_DATABASE_URL (preferred) or TEST_DATABASE_URL.
 *
 * These are persisted forensic-reader fixtures, NOT bridge/permission/caller
 * acceptance. Direct inserts deliberately include historical corruption that
 * an authorized writer must refuse. No mocks, trigger/RLS disabling, provider
 * sends, cleanup, refunds through the bridge, or real pharmacy data. Rows are
 * retained; the independent QA owner stops its database outside this suite.
 */
import { randomBytes } from 'node:crypto';
import {
  accountsTestDatabase,
  assertAccountsTestDatabase,
} from '@/lib/testing/accounts-test-database';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { StoredValueDb } from '@/lib/stored-value/ledger';
import type { WalletReconciliationScope } from './wallet-reconciliation';

type Currency = 'PKR' | 'USD';
type Kind = 'TOP_UP' | 'SPEND' | 'REFUND' | 'EXPIRY' | 'ADJUSTMENT';
type Tender = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CREDIT' | 'LOYALTY' | 'WALLET';
type Report = Awaited<ReturnType<typeof import('./wallet-reporting').readWalletReconciliation>>;
type Fixture = {
  organizationId: string;
  branchId: string;
  otherBranchId: string;
  actorId: string;
  customer: Record<Currency, string>;
  liability: Record<Currency, string>;
  cash: Record<Currency, string>;
  sales: Record<Currency, string>;
};
type Event = {
  id: string;
  branchId: string;
  currency: Currency;
  kind: Kind;
  tender: Tender | null;
  deltaMinor: number;
  at: Date;
  saleId: string | null;
  journalCurrency: Currency | null;
  originalJournalId: string | null;
  actorId: string;
};
type EventOptions = Partial<Omit<Event, 'id'>> & {
  id?: string;
  counterCurrency?: Currency;
};
type CanonicalOptions = {
  id?: string;
  sourceId?: string;
  currency?: Currency;
  deltaMinor?: number;
  at?: Date;
  lineBranchId?: string | null;
  headerBranchId?: string | null;
  idempotencyKey?: string;
  actorId?: string;
  walletSourceLineId?: string | null;
};

const optedIn = process.env.PHARMACY_WALLET_REPORTING_TEST_DB === '1';
if (optedIn && process.env.PHARMACY_WALLET_REPORTING_DISPOSABLE_DB !== '1')
  throw new Error('WALLET_REPORT_TEST_REQUIRES_EXPLICIT_DISPOSABLE_DATABASE');
const target = optedIn ? accountsTestDatabase(process.env) : undefined;
if (target) process.env.DATABASE_URL = target.url;
const describeDb = optedIn ? describe.sequential : describe.skip;
const unique = (label: string) => `wrdb_${label}_${randomBytes(8).toString('hex')}`;
const FROM = new Date('2026-10-24T00:00:00.000Z');
const TO = new Date('2026-10-25T00:00:00.000Z');
const DURING = new Date('2026-10-24T12:00:00.000Z');
const BEFORE = new Date('2026-10-23T23:59:59.999Z');
let scoped: typeof import('@/lib/tenancy/scoped-db');
let reporting: typeof import('./wallet-reporting');

function scope(f: Fixture, branchId = f.branchId): WalletReconciliationScope {
  return { organizationId: f.organizationId, branchId, from: FROM, to: TO };
}

type OwnershipShape = 'valid' | 'unowned-liability' | 'owned-clearing';

async function fixture(ownership: OwnershipShape = 'valid'): Promise<Fixture> {
  const f: Fixture = {
    organizationId: unique('org'),
    branchId: unique('branch'),
    otherBranchId: unique('other_branch'),
    actorId: unique('actor'),
    customer: { PKR: unique('pkr_customer'), USD: unique('usd_customer') },
    liability: { PKR: unique('pkr_wallet'), USD: unique('usd_wallet') },
    cash: { PKR: unique('pkr_cash'), USD: unique('usd_cash') },
    sales: { PKR: unique('pkr_sales'), USD: unique('usd_sales') },
  };
  await scoped.withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: f.organizationId,
        slug: f.organizationId,
        legalName: 'Synthetic reporting fixture',
        displayName: 'Synthetic reporting fixture',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        deploymentMode: 'SHARED',
        currency: 'PKR',
      },
    })
  );
  await scoped.withTenantDb(f.organizationId, async (db) => {
    for (const id of [f.branchId, f.otherBranchId]) {
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId: f.organizationId,
          code: id,
          name: 'Synthetic branch',
          addressLine: 'Synthetic',
          city: 'Synthetic',
          provinceCode: 'PB',
          active: true,
        },
      });
    }
    for (const currency of ['PKR', 'USD'] as const) {
      // Unique(org, customer, kind) excludes currency. Use a distinct real
      // tenant-owned customer AND patient for each currency, not fake owners
      // or duplicate liability accounts for one customer.
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: f.organizationId, displayName: 'Synthetic reporting patient' },
      });
      await db.pharmacyCustomer.create({
        data: {
          id: f.customer[currency],
          organizationId: f.organizationId,
          patientId: patient.id,
          displayName: 'Synthetic reporting customer',
          active: true,
        },
      });
      await db.storedValueAccount.createMany({
        data: [
          // Deliberately stale cache: readers must derive liability from history,
          // not assign this tenant/customer-wide cache to either actual branch.
          {
            id: f.liability[currency],
            organizationId: f.organizationId,
            kind: 'CUSTOMER_LIABILITY',
            // Only the explicit forensic negative case omits ownership.
            customerId: ownership === 'unowned-liability' ? null : f.customer[currency],
            currency,
            balanceMinor: 777,
          },
          {
            id: f.cash[currency],
            organizationId: f.organizationId,
            kind: 'CASH_CLEARING',
            // Clearing is unowned except in the explicit corruption case.
            customerId: ownership === 'owned-clearing' ? f.customer[currency] : null,
            currency,
            balanceMinor: 0,
          },
          {
            id: f.sales[currency],
            organizationId: f.organizationId,
            kind: 'SALES_CLEARING',
            customerId: null,
            currency,
            balanceMinor: 0,
          },
        ],
      });
    }
  });
  return f;
}

/** Must be called inside one tenant transaction (deferred balance triggers). */
async function wallet(db: ScopedDb, f: Fixture, options: EventOptions = {}): Promise<Event> {
  const kind = options.kind ?? 'TOP_UP';
  const event: Event = {
    id: options.id ?? unique('event'),
    branchId: options.branchId ?? f.branchId,
    currency: options.currency ?? 'PKR',
    kind,
    tender: options.tender === undefined ? (kind === 'TOP_UP' ? 'CASH' : null) : options.tender,
    deltaMinor: options.deltaMinor ?? (kind === 'TOP_UP' ? 1000 : -100),
    at: options.at ?? DURING,
    journalCurrency:
      options.journalCurrency === undefined ? (options.currency ?? 'PKR') : options.journalCurrency,
    originalJournalId: options.originalJournalId ?? null,
    actorId: options.actorId ?? f.actorId,
    saleId:
      options.saleId === undefined
        ? kind === 'SPEND'
          ? unique('sale_reference')
          : null
        : options.saleId,
  };
  await db.storedValueJournal.create({
    data: {
      id: event.id,
      organizationId: f.organizationId,
      branchId: event.branchId,
      idempotencyKey: event.id,
      kind: event.kind,
      currency: event.journalCurrency,
      originalJournalId: event.originalJournalId,
      actorId: event.actorId,
      tender: event.tender,
      occurredAt: event.at,
      saleId: event.saleId,
      reason: 'Synthetic forensic reporting fixture',
    },
  });
  const counterCurrency = options.counterCurrency ?? event.currency;
  const counterId = kind === 'SPEND' ? f.sales[counterCurrency] : f.cash[counterCurrency];
  await db.storedValueEntry.createMany({
    data: [
      {
        id: unique('wallet_leg'),
        organizationId: f.organizationId,
        journalId: event.id,
        accountId: f.liability[event.currency],
        amountMinor: event.deltaMinor,
        occurredAt: event.at,
      },
      {
        id: unique('counter_leg'),
        organizationId: f.organizationId,
        journalId: event.id,
        accountId: counterId,
        amountMinor: -event.deltaMinor,
        occurredAt: event.at,
      },
    ],
  });
  return event;
}

/** Existing schema permits duplicate source IDs, but never duplicate keys. */
async function canonical(db: ScopedDb, f: Fixture, event: Event, options: CanonicalOptions = {}) {
  const id = options.id ?? unique('canonical');
  const delta = options.deltaMinor ?? event.deltaMinor;
  const sourceId = options.sourceId ?? event.id;
  const branchId = options.lineBranchId === undefined ? event.branchId : options.lineBranchId;
  const counter =
    event.kind === 'SPEND'
      ? 'SALES_CLEARING'
      : event.tender === 'CARD' || event.tender === 'BANK_TRANSFER'
        ? 'BANK'
        : 'CASH';
  await db.financeJournalEntry.create({
    data: {
      id,
      organizationId: f.organizationId,
      branchId: options.headerBranchId === undefined ? event.branchId : options.headerBranchId,
      sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL',
      sourceId,
      idempotencyKey: options.idempotencyKey ?? `finance:PHARMACY_STORED_VALUE_JOURNAL:${sourceId}`,
      description: 'Synthetic immutable reporting fixture',
      currency: options.currency ?? event.currency,
      actorId: options.actorId ?? event.actorId,
      occurredAt: options.at ?? event.at,
    },
  });
  await db.financeJournalLine.createMany({
    data: [
      {
        id: unique('canonical_liability'),
        organizationId: f.organizationId,
        entryId: id,
        accountCode: 'CUSTOMER_WALLET_LIABILITY',
        side: delta > 0 ? 'CREDIT' : 'DEBIT',
        sourceLineId:
          options.walletSourceLineId === undefined
            ? `${sourceId}:wallet`
            : options.walletSourceLineId,
        amountMinor: Math.abs(delta),
        branchId,
      },
      {
        id: unique('canonical_counter'),
        organizationId: f.organizationId,
        entryId: id,
        accountCode: counter,
        side: delta > 0 ? 'DEBIT' : 'CREDIT',
        sourceLineId: `${sourceId}:counterparty`,
        amountMinor: Math.abs(delta),
        branchId,
      },
    ],
  });
}

async function pair(
  db: ScopedDb,
  f: Fixture,
  options: EventOptions = {},
  posting: CanonicalOptions = {}
) {
  const event = await wallet(db, f, options);
  await canonical(db, f, event, posting);
  return event;
}

async function report(f: Fixture, branchId = f.branchId) {
  return scoped.withTenantDb(
    f.organizationId,
    async (db) => {
      // Pin the prepared-query plan: cold fixture cardinality estimates can pick
      // a quadratic custom plan for the canonical evidence join. Keep the real
      // query, row cap, and tenant policies, without JIT startup variance.
      await db.$executeRawUnsafe('SET LOCAL jit = off');
      await db.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_generic_plan');
      return reporting.readWalletReconciliation(db, scope(f, branchId));
    },
    // The cap regression reads 10,000 persisted rows under enforced RLS.
    { timeout: 30_000 }
  );
}
function currencyRow(result: Report, currency: Currency = 'PKR') {
  const row = result.currencies.find((item) => item.currency === currency);
  expect(row).toBeDefined();
  return row!;
}
function expectIdentity(result: Report) {
  for (const row of result.currencies) {
    expect(typeof row.walletClosingMinor).toBe('string');
    expect(typeof row.canonicalClosingMinor).toBe('string');
    expect(BigInt(row.walletOpeningMinor) + BigInt(row.walletChangeMinor)).toBe(
      BigInt(row.walletClosingMinor)
    );
    expect(BigInt(row.canonicalOpeningMinor) + BigInt(row.canonicalChangeMinor)).toBe(
      BigInt(row.canonicalClosingMinor)
    );
  }
}
function expectIssue(result: Report, sourceId: string, code: Report['issues'][number]['code']) {
  expect(result.status).toBe('HOLD');
  expect(result.issues).toContainEqual({ sourceId, code });
}

/** Bounded bulk seeding: actual INTEGER legs and real deferred constraints. */
async function matchedBatch(db: ScopedDb, f: Fixture, count: number) {
  const prefix = unique('batch');
  await db.$executeRawUnsafe(
    `
    INSERT INTO stored_value_journals
      (id,"organizationId","branchId",kind,"idempotencyKey","actorId",tender,currency,"occurredAt")
    SELECT $1||'_w_'||n,$2,$3,'TOP_UP',$1||'_w_'||n,$4,'CASH','PKR',$5
    FROM generate_series(1,$6::integer) AS g(n)`,
    prefix,
    f.organizationId,
    f.branchId,
    f.actorId,
    DURING,
    count
  );
  await db.$executeRawUnsafe(
    `
    INSERT INTO stored_value_entries (id,"organizationId","journalId","accountId","amountMinor","occurredAt")
    SELECT $1||'_wl_'||n,$2,$1||'_w_'||n,$3,1,$5::timestamp(3) FROM generate_series(1,$6::integer) AS g(n)
    UNION ALL
    SELECT $1||'_wc_'||n,$2,$1||'_w_'||n,$4,-1,$5::timestamp(3) FROM generate_series(1,$6::integer) AS g(n)`,
    prefix,
    f.organizationId,
    f.liability.PKR,
    f.cash.PKR,
    DURING,
    count
  );
  await db.$executeRawUnsafe(
    `
    INSERT INTO finance_journal_entries
      (id,"organizationId","branchId","sourceKind","sourceId",description,currency,"actorId","occurredAt","idempotencyKey")
    SELECT $1||'_f_'||n,$2,$3,'PHARMACY_STORED_VALUE_JOURNAL',$1||'_w_'||n,
      'Synthetic cap fixture','PKR',$4,$5,'finance:PHARMACY_STORED_VALUE_JOURNAL:'||$1||'_w_'||n
    FROM generate_series(1,$6::integer) AS g(n)`,
    prefix,
    f.organizationId,
    f.branchId,
    f.actorId,
    DURING,
    count
  );
  await db.$executeRawUnsafe(
    `
    INSERT INTO finance_journal_lines (id,"organizationId","entryId","accountCode",side,"amountMinor","branchId","sourceLineId")
    SELECT $1||'_fl_'||n,$2,$1||'_f_'||n,'CUSTOMER_WALLET_LIABILITY'::"FinanceAccountCode",
      'CREDIT'::"FinanceJournalSide",1,$3,$1||'_w_'||n||':wallet' FROM generate_series(1,$4::integer) AS g(n)
    UNION ALL
    SELECT $1||'_fc_'||n,$2,$1||'_f_'||n,'CASH'::"FinanceAccountCode",
      'DEBIT'::"FinanceJournalSide",1,$3,$1||'_w_'||n||':counterparty' FROM generate_series(1,$4::integer) AS g(n)`,
    prefix,
    f.organizationId,
    f.branchId,
    count
  );
}

describeDb('wallet reports on persisted, tenant-isolated PostgreSQL evidence', () => {
  beforeAll(async () => {
    process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    scoped = await import('@/lib/tenancy/scoped-db');
    await assertAccountsTestDatabase(scoped.withPlatformDb, target!);
    reporting = await import('./wallet-reporting');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    const tables = await scoped.withPlatformDb((db) =>
      db.$queryRawUnsafe<
        Array<{
          name: string;
          enabled: boolean;
          forced: boolean;
          owner: boolean;
        }>
      >(`SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
        pg_has_role(current_user,c.relowner,'USAGE') AS owner
      FROM pg_class c WHERE c.oid = ANY(ARRAY[
        'public.stored_value_accounts'::regclass,'public.stored_value_journals'::regclass,
        'public.stored_value_entries'::regclass,'public.finance_journal_entries'::regclass,
        'public.finance_journal_lines'::regclass])`)
    );
    expect(tables).toHaveLength(5);
    expect(tables.every((table) => table.enabled && table.forced && !table.owner)).toBe(true);
  }, 30_000);

  it('uses separate real tenant-owned customers per currency and leaves normal clearing unowned', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, async (db) => {
      const customers = await db.pharmacyCustomer.findMany({
        where: { organizationId: f.organizationId },
        include: { patient: true },
      });
      expect(customers).toHaveLength(2);
      expect(new Set(customers.map((customer) => customer.patientId)).size).toBe(2);
      const accounts = await db.storedValueAccount.findMany({
        where: { organizationId: f.organizationId },
      });
      expect(accounts).toHaveLength(6);
      for (const currency of ['PKR', 'USD'] as const) {
        expect(customers).toContainEqual(
          expect.objectContaining({
            id: f.customer[currency],
            organizationId: f.organizationId,
            active: true,
            patient: expect.objectContaining({ organizationId: f.organizationId }),
          })
        );
        expect(accounts).toContainEqual(
          expect.objectContaining({
            id: f.liability[currency],
            organizationId: f.organizationId,
            kind: 'CUSTOMER_LIABILITY',
            customerId: f.customer[currency],
            currency,
          })
        );
        for (const id of [f.cash[currency], f.sales[currency]]) {
          expect(accounts).toContainEqual(
            expect.objectContaining({
              id,
              organizationId: f.organizationId,
              customerId: null,
              currency,
            })
          );
        }
        await pair(db, f, { currency });
      }
    });
    const result = await report(f);
    expect(result).toMatchObject({
      status: 'RECONCILED',
      walletEventCount: 2,
      canonicalEntryCount: 2,
      issues: [],
    });
    expect(result.currencies).toHaveLength(2);
    expectIdentity(result);
  });

  it.each(['unowned-liability', 'owned-clearing'] as const)(
    'holds persisted %s account ownership even when both ledgers balance',
    async (ownership) => {
      const f = await fixture(ownership);
      const event = await scoped.withTenantDb(f.organizationId, (db) => pair(db, f));
      const result = await report(f);
      expectIssue(result, event.id, 'INVALID_WALLET_ENTRY');
      expect(currencyRow(result).closingDifferenceMinor).toBe('0');
    }
  );

  it('derives actual-branch liability from history, not the tenant/customer cache', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, async (db) => {
      await pair(db, f, { deltaMinor: 1000 });
      await pair(db, f, { branchId: f.otherBranchId, deltaMinor: 2000 });
    });
    await scoped.withTenantDb(f.organizationId, async (db) => {
      expect(await reporting.readWalletLiability(db, f.organizationId, f.branchId, FROM)).toEqual({
        liabilityMinor: 1000,
        topUpCashInMinor: 1000,
      });
      expect(
        await reporting.readWalletLiability(db, f.organizationId, f.otherBranchId, FROM)
      ).toEqual({ liabilityMinor: 2000, topUpCashInMinor: 2000 });
      expect(await reporting.readWalletLiability(db, f.organizationId, undefined, FROM)).toEqual({
        liabilityMinor: 3000,
        topUpCashInMinor: 3000,
      });
      const account = await db.storedValueAccount.findUniqueOrThrow({
        where: { id: f.liability.PKR },
      });
      expect(account.balanceMinor).toBe(777);
    });
  });

  it('keeps the legacy cash-in query UTC half-open; its historical CARD count is not bridge approval', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, async (db) => {
      await wallet(db, f, { at: BEFORE, deltaMinor: 100 });
      await wallet(db, f, { at: FROM, deltaMinor: 200 });
      await wallet(db, f, { tender: 'BANK_TRANSFER', deltaMinor: 300 });
      // Legacy numeric cash-in includes CARD; reconciliation separately HOLDS it.
      await wallet(db, f, { tender: 'CARD', deltaMinor: 400 });
      for (const tender of ['CREDIT', 'LOYALTY', 'WALLET'] as const)
        await wallet(db, f, { tender, deltaMinor: 500 });
      await wallet(db, f, { at: TO, deltaMinor: 800 });
    });
    const result = await scoped.withTenantDb(f.organizationId, (db) =>
      reporting.readWalletLiability(db, f.organizationId, f.branchId, DURING)
    );
    expect(result).toEqual({ liabilityMinor: 3300, topUpCashInMinor: 900 });
  });

  it('reconciles opening + change = closing with PKR SPEND clearing, excluding the upper boundary', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, async (db) => {
      await pair(db, f, { at: BEFORE, deltaMinor: 1000 });
      await pair(db, f, { at: FROM, deltaMinor: 500 });
      await pair(db, f, { kind: 'SPEND', deltaMinor: -200 });
      await pair(db, f, { at: TO, deltaMinor: 99_999 });
    });
    const result = await report(f);
    expect(result).toMatchObject({
      status: 'RECONCILED',
      walletEventCount: 3,
      canonicalEntryCount: 3,
      issues: [],
    });
    expect(currencyRow(result)).toMatchObject({
      walletOpeningMinor: '1000',
      walletChangeMinor: '300',
      walletClosingMinor: '1300',
      canonicalOpeningMinor: '1000',
      canonicalChangeMinor: '300',
      canonicalClosingMinor: '1300',
      openingDifferenceMinor: '0',
      changeDifferenceMinor: '0',
      closingDifferenceMinor: '0',
    });
    expectIdentity(result);
  });

  it('reconciles BANK_TRANSFER funding with matching BANK provenance', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, (db) => pair(db, f, { tender: 'BANK_TRANSFER' }));
    expect(await report(f)).toMatchObject({
      status: 'RECONCILED',
      walletEventCount: 1,
      canonicalEntryCount: 1,
      issues: [],
    });
  });

  it('holds a mismatched canonical header while attributing money only to its actual lines', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, {}, { headerBranchId: f.otherBranchId })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'DIMENSION_MISMATCH');
    expect(currencyRow(result)).toMatchObject({
      walletClosingMinor: '1000',
      canonicalClosingMinor: '1000',
      closingDifferenceMinor: '0',
    });
    const headerBranch = await report(f, f.otherBranchId);
    expectIssue(headerBranch, event.id, 'DIMENSION_MISMATCH');
    expect(currencyRow(headerBranch)).toMatchObject({
      walletClosingMinor: '0',
      canonicalClosingMinor: '0',
    });
  });

  it.each([
    { idempotencyKey: 'synthetic_wrong_key' },
    { actorId: 'synthetic_wrong_actor' },
    { walletSourceLineId: null },
  ])('holds canonical key/actor/leg-source corruption %# despite equal totals', async (posting) => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) => pair(db, f, {}, posting));
    const result = await report(f);
    expectIssue(result, event.id, 'SOURCE_PROVENANCE_MISMATCH');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds legacy null journal currency instead of inferring provenance from account currency', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, { journalCurrency: null })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'MISSING_EVENT_PROVENANCE');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds journal/account currency disagreement even when both ledgers agree', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, { journalCurrency: 'USD' })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'CURRENCY_MISMATCH');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it.each(['TOP_UP', 'SPEND'] as const)(
    'holds an original-funding reference on persisted %s',
    async (kind) => {
      const f = await fixture();
      const event = await scoped.withTenantDb(f.organizationId, async (db) => {
        const original = await pair(db, f);
        return pair(db, f, { kind, originalJournalId: original.id });
      });
      const result = await report(f);
      expectIssue(result, event.id, 'UNSUPPORTED_EVENT');
      expect(currencyRow(result).closingDifferenceMinor).toBe('0');
    }
  );

  it('holds historical CARD topup even with a balanced BANK canonical posting', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, { tender: 'CARD' })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'UNSUPPORTED_EVENT');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds USD SPEND without silently adopting the PKR sale default', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, { kind: 'SPEND', currency: 'USD' })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'UNSUPPORTED_EVENT');
    expect(currencyRow(result, 'USD').closingDifferenceMinor).toBe('0');
  });

  it('preserves the deferred finance-header constraint by rejecting an orphan with zero lines', async () => {
    const f = await fixture();
    const sourceId = unique('header_only_orphan');
    // This migration checks header INSERT at commit, not just line INSERT.
    // Such a row cannot persist in this real-constraint harness: assert its
    // rejection, not an unreachable reporting result or a disabled trigger.
    await expect(
      scoped.withTenantDb(f.organizationId, (db) =>
        db.financeJournalEntry.create({
          data: {
            id: unique('canonical_header'),
            organizationId: f.organizationId,
            branchId: f.branchId,
            sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL',
            sourceId,
            idempotencyKey: `finance:PHARMACY_STORED_VALUE_JOURNAL:${sourceId}`,
            description: 'Synthetic zero-line orphan',
            currency: 'PKR',
            actorId: f.actorId,
            occurredAt: DURING,
          },
        })
      )
    ).rejects.toThrow('FINANCE_ENTRY_INCOMPLETE');
    // A failed transaction rolls back naturally; no data cleanup is requested.
    expect(await report(f)).toMatchObject({
      status: 'EMPTY',
      walletEventCount: 0,
      canonicalEntryCount: 0,
      issues: [],
    });
  });

  it('keeps aggregate bigint minor units exact and separate for PKR and USD; legacy numeric API refuses mixing', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, async (db) => {
      // Individual persisted legs are INTEGER, not invented BIGINT columns.
      // Their sums cross 32-bit range; the API returns exact decimal strings.
      for (let n = 0; n < 2; n++) {
        await pair(db, f, {
          currency: 'PKR',
          at: n === 0 ? BEFORE : FROM,
          deltaMinor: 2_000_000_000,
        });
        await pair(db, f, {
          currency: 'USD',
          at: n === 0 ? BEFORE : FROM,
          deltaMinor: 1_500_000_000,
        });
      }
    });
    const result = await report(f);
    expect(result.status).toBe('RECONCILED');
    expect(result.currencies.map((row) => row.currency)).toEqual(['PKR', 'USD']);
    expect(currencyRow(result, 'PKR')).toMatchObject({
      walletOpeningMinor: '2000000000',
      walletChangeMinor: '2000000000',
      walletClosingMinor: '4000000000',
      canonicalClosingMinor: '4000000000',
      closingDifferenceMinor: '0',
    });
    expect(currencyRow(result, 'USD')).toMatchObject({
      walletOpeningMinor: '1500000000',
      walletChangeMinor: '1500000000',
      walletClosingMinor: '3000000000',
      canonicalClosingMinor: '3000000000',
      closingDifferenceMinor: '0',
    });
    expectIdentity(result);
    await expect(
      scoped.withTenantDb(f.organizationId, (db) =>
        reporting.readWalletLiability(db, f.organizationId, f.branchId)
      )
    ).rejects.toThrow('WALLET_REPORT_CURRENCY_REQUIRED');
  });

  it('reads both ledgers in one real SQL snapshot despite a canonical commit between query and return', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) => wallet(db, f));
    let statements = 0;
    const result = await scoped.withTenantDb(f.organizationId, async (db) => {
      const observed: StoredValueDb = {
        async $queryRaw<T>(query: Parameters<StoredValueDb['$queryRaw']>[0]): Promise<T> {
          statements++;
          // All returned rows come from PostgreSQL, never a snapshot mock.
          const rows = await db.$queryRaw<T>(query);
          if (statements === 1) {
            // A second scoped transaction commits AFTER the report SELECT's
            // snapshot. A two-query reader could mix the before/after states.
            await scoped.withTenantDb(f.organizationId, (writer) => canonical(writer, f, event));
          }
          return rows;
        },
        $executeRaw: (query) => db.$executeRaw(query),
      };
      return reporting.readWalletReconciliation(observed, scope(f));
    });
    expect(statements).toBe(1);
    expect(result.canonicalEntryCount).toBe(0);
    expectIssue(result, event.id, 'MISSING_CANONICAL');
    const nextSnapshot = await report(f);
    expect(nextSnapshot).toMatchObject({
      status: 'RECONCILED',
      walletEventCount: 1,
      canonicalEntryCount: 1,
      issues: [],
    });
  });

  it('holds a persisted wallet event with no canonical posting', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) => wallet(db, f));
    const result = await report(f);
    expectIssue(result, event.id, 'MISSING_CANONICAL');
    expect(currencyRow(result).closingDifferenceMinor).toBe('1000');
  });

  it('holds equal-net substitutions with the wrong immutable source identity', async () => {
    const f = await fixture();
    const orphanSource = unique('orphan_source');
    const event = await scoped.withTenantDb(f.organizationId, async (db) => {
      const event = await wallet(db, f);
      await canonical(db, f, event, { sourceId: orphanSource });
      return event;
    });
    const result = await report(f);
    expectIssue(result, event.id, 'MISSING_CANONICAL');
    expectIssue(result, orphanSource, 'ORPHAN_CANONICAL');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds equal-net swapped amounts even when every source ID exists', async () => {
    const f = await fixture();
    const events = await scoped.withTenantDb(f.organizationId, async (db) => {
      const a = await wallet(db, f, { deltaMinor: 1000 });
      const b = await wallet(db, f, { deltaMinor: 2000 });
      await canonical(db, f, a, { deltaMinor: 2000 });
      await canonical(db, f, b, { deltaMinor: 1000 });
      return [a, b];
    });
    const result = await report(f);
    for (const event of events) expectIssue(result, event.id, 'AMOUNT_MISMATCH');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds duplicate canonical sources even if their combined liability equals the wallet event', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, async (db) => {
      const event = await wallet(db, f);
      await canonical(db, f, event, { deltaMinor: 500 });
      // The DB forbids duplicate idempotency keys, not duplicate source IDs.
      await canonical(db, f, event, { deltaMinor: 500, idempotencyKey: unique('duplicate_key') });
      return event;
    });
    const result = await report(f);
    expectIssue(result, event.id, 'DUPLICATE_CANONICAL_SOURCE');
    expect(result.canonicalEntryCount).toBe(2);
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it('holds wrong-branch canonical matches without attributing their money to the wallet branch', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, async (db) => {
      const event = await wallet(db, f, { deltaMinor: 750 });
      await canonical(db, f, event, { lineBranchId: f.otherBranchId });
      return event;
    });
    const result = await report(f);
    expectIssue(result, event.id, 'DIMENSION_MISMATCH');
    expect(currencyRow(result)).toMatchObject({
      walletClosingMinor: '750',
      canonicalClosingMinor: '0',
      closingDifferenceMinor: '750',
    });
    const actualCanonicalBranch = await report(f, f.otherBranchId);
    expectIssue(actualCanonicalBranch, event.id, 'ORPHAN_CANONICAL');
    expect(currencyRow(actualCanonicalBranch)).toMatchObject({
      walletClosingMinor: '0',
      canonicalClosingMinor: '750',
    });
  });

  it('holds currency mismatches instead of netting unlike minor units', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, async (db) => {
      const event = await wallet(db, f);
      await canonical(db, f, event, { currency: 'USD' });
      return event;
    });
    const result = await report(f);
    expectIssue(result, event.id, 'CURRENCY_MISMATCH');
    expect(currencyRow(result, 'PKR').closingDifferenceMinor).toBe('1000');
    expect(currencyRow(result, 'USD').closingDifferenceMinor).toBe('-1000');
    expectIdentity(result);
  });

  it.each([BEFORE, TO])(
    'holds a linked canonical timestamp on the wrong period boundary (%s)',
    async (at) => {
      const f = await fixture();
      const event = await scoped.withTenantDb(f.organizationId, (db) =>
        pair(db, f, { at: FROM }, { at })
      );
      const result = await report(f);
      expectIssue(result, event.id, 'TIME_MISMATCH');
      if (at.getTime() === TO.getTime()) {
        expect(currencyRow(result)).toMatchObject({
          canonicalClosingMinor: '0',
          closingDifferenceMinor: '1000',
        });
      } else {
        expect(currencyRow(result)).toMatchObject({
          openingDifferenceMinor: '-1000',
          changeDifferenceMinor: '1000',
          closingDifferenceMinor: '0',
        });
      }
      expectIdentity(result);
    }
  );

  it('holds a persisted header with missing legs instead of treating incomplete evidence as reconciled', async () => {
    const f = await fixture();
    const id = unique('incomplete');
    await scoped.withTenantDb(f.organizationId, (db) =>
      db.storedValueJournal.create({
        data: {
          id,
          organizationId: f.organizationId,
          branchId: f.branchId,
          kind: 'TOP_UP',
          idempotencyKey: id,
          actorId: f.actorId,
          tender: 'CASH',
          currency: 'PKR',
          occurredAt: DURING,
        },
      })
    );
    // The migrated stored-value balance trigger is on entries, so this
    // historical header-only shape is persistable without disabling anything.
    const result = await report(f);
    expectIssue(result, id, 'INVALID_WALLET_ENTRY');
    expectIssue(result, id, 'MISSING_CANONICAL');
    expect(result.walletEventCount).toBe(1);
  });

  it('holds a signed-zero journal whose two persisted accounts have different currencies', async () => {
    const f = await fixture();
    const event = await scoped.withTenantDb(f.organizationId, (db) =>
      pair(db, f, { currency: 'PKR', counterCurrency: 'USD' })
    );
    const result = await report(f);
    expectIssue(result, event.id, 'INVALID_WALLET_ENTRY');
    expect(currencyRow(result).closingDifferenceMinor).toBe('0');
  });

  it.each(['REFUND', 'EXPIRY', 'ADJUSTMENT'] as const)(
    'holds unsupported persisted %s even with balanced matching legs',
    async (kind) => {
      const f = await fixture();
      const event = await scoped.withTenantDb(f.organizationId, (db) =>
        pair(db, f, { kind, deltaMinor: -100 })
      );
      const result = await report(f);
      expectIssue(result, event.id, 'UNSUPPORTED_EVENT');
      expect(currencyRow(result).closingDifferenceMinor).toBe('0');
    }
  );

  it('keeps foreign-tenant evidence invisible even when explicitly requested under the wrong RLS context', async () => {
    const local = await fixture();
    const foreign = await fixture();
    await scoped.withTenantDb(foreign.organizationId, (db) => pair(db, foreign));
    await scoped.withTenantDb(local.organizationId, async (db) => {
      const rows = await db.storedValueJournal.findMany({
        where: { organizationId: foreign.organizationId },
      });
      expect(rows).toEqual([]);
      const result = await reporting.readWalletReconciliation(db, scope(foreign));
      expect(result).toMatchObject({
        status: 'EMPTY',
        walletEventCount: 0,
        canonicalEntryCount: 0,
        currencies: [],
        issues: [],
      });
      const amounts = await reporting.readWalletLiability(
        db,
        foreign.organizationId,
        foreign.branchId
      );
      expect(amounts).toEqual({ liabilityMinor: 0, topUpCashInMinor: 0 });
    });
  });

  it('reports an empty actual branch as EMPTY, never RECONCILED', async () => {
    const f = await fixture();
    await scoped.withTenantDb(f.organizationId, (db) => pair(db, f));
    expect(await report(f, f.otherBranchId)).toMatchObject({
      status: 'EMPTY',
      walletEventCount: 0,
      canonicalEntryCount: 0,
      currencies: [],
      issues: [],
    });
  });

  it('refuses capped history explicitly; no partial snapshot may be called reconciled', async () => {
    const f = await fixture();
    const count = Math.floor(reporting.MAX_WALLET_RECONCILIATION_ROWS / 2);
    await scoped.withTenantDb(f.organizationId, (db) => matchedBatch(db, f, count), {
      timeout: 30_000,
    });
    const complete = await report(f);
    expect(complete).toMatchObject({
      status: 'RECONCILED',
      walletEventCount: count,
      canonicalEntryCount: count,
      issues: [],
    });
    expect(currencyRow(complete)).toMatchObject({
      walletClosingMinor: String(count),
      canonicalClosingMinor: String(count),
      closingDifferenceMinor: '0',
    });
    await scoped.withTenantDb(f.organizationId, (db) => pair(db, f, { deltaMinor: 1 }));
    // Current internal API refuses via RangeError, not a fabricated HOLD DTO.
    // The caller must surface this refusal, never catch it as an empty report.
    await expect(report(f)).rejects.toThrow('WALLET_RECONCILIATION_RANGE_TOO_LARGE');
  }, 60_000);
});
