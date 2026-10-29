import { postStoredValueJournal } from '@/lib/stored-value/ledger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ACCOUNT_NORMAL_SIDE, signedMinor } from '@/lib/finance/journal';
import {
  postPharmacyStoredValue,
  postPharmacyStoredValueInTransaction,
  type PharmacyStoredValueCommand,
  type StoredValuePostingScope,
} from './stored-value-finance';

const transaction = vi.hoisted(() => ({
  run: null as unknown as (
    organizationId: string,
    fn: (db: ScopedDb) => Promise<unknown>
  ) => Promise<unknown>,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (organizationId: string, fn: (db: ScopedDb) => Promise<unknown>) =>
    transaction.run(organizationId, fn),
}));

type Sql = { sql: string; values: unknown[] };
type Account = {
  id: string;
  organizationId: string;
  customerId: string | null;
  kind: string;
  currency: string;
  balanceMinor: number;
};
type Journal = {
  id: string;
  organizationId: string;
  branchId: string | null;
  kind: string;
  idempotencyKey: string;
  saleId: string | null;
  actorId: string;
  tender: string | null;
  reason: string | null;
  currency: string | null;
  originalJournalId: string | null;
  occurredAt: Date;
};
type Entry = {
  id: string;
  organizationId: string;
  journalId: string;
  accountId: string;
  amountMinor: number;
};
type CanonicalLine = {
  organizationId: string;
  entryId: string;
  accountCode: string;
  side: string;
  amountMinor: number;
  branchId: string | null;
  productId: string | null;
  lotId: string | null;
  locationId: string | null;
  sourceLineId: string | null;
  memo: string | null;
};
type Canonical = {
  id: string;
  organizationId: string;
  branchId: string | null;
  sourceKind: string;
  sourceId: string;
  currency: string;
  actorId: string;
  occurredAt: Date;
  idempotencyKey: string;
  description: string;
  reversesEntryId: string | null;
  reversalReason: string | null;
  lines: CanonicalLine[];
};
type State = {
  accounts: Account[];
  journals: Journal[];
  entries: Entry[];
  canonical: Canonical[];
  sequence: number;
};
let state: State;
let failAt: string | null;
let deny: string | null;
let refundAllowed: boolean;
let deniedScope: string | null;
let saleCustomer: string;
let saleStatus: string;
let saleTotal: number;
let otherTenders: number;
let queue: Promise<unknown>;
const scope: StoredValuePostingScope = {
  organizationId: 'tenant-a',
  branchId: 'branch-a',
  actorId: 'cashier-a',
  currency: 'PKR',
};
const topup = (overrides = {}): PharmacyStoredValueCommand => ({
  kind: 'TOP_UP',
  journalId: 'topup-a',
  idempotencyKey: 'request-a',
  accountId: 'wallet-a',
  counterpartyAccountId: 'cash-a',
  amountMinor: 200,
  tender: 'CASH',
  ...overrides,
});
const spend = (overrides = {}): PharmacyStoredValueCommand => ({
  kind: 'SPEND',
  journalId: 'spend-a',
  idempotencyKey: 'spend-request',
  accountId: 'wallet-a',
  counterpartyAccountId: 'sale-a',
  saleId: 'sale-1',
  amountMinor: 200,
  ...overrides,
});
const refund = (overrides = {}): PharmacyStoredValueCommand => ({
  kind: 'REFUND',
  journalId: 'refund-a',
  idempotencyKey: 'refund-request',
  accountId: 'wallet-a',
  counterpartyAccountId: 'cash-a',
  originalJournalId: 'topup-a',
  amountMinor: 100,
  ...overrides,
});
function inject(stage: string) {
  if (failAt === stage) throw new Error(`injected:${stage}`);
}
function balance() {
  return state.accounts.find((row) => row.id === 'wallet-a')!.balanceMinor;
}
function canonicalFind(where: Record<string, unknown>) {
  return (
    state.canonical.find(
      (row) =>
        row.organizationId === where.organizationId &&
        (where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey)
    ) ?? null
  );
}

/** Transactional MODEL: executes real adapter/subledger/kernel/ABAC against fake delegates.
 * It proves composition and failure propagation, NOT PostgreSQL locks/RLS/constraints. */
function dbFor(organizationId: string): ScopedDb {
  const db = {
    organization: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        deniedScope === 'tenant' || where.id !== organizationId ? null : { currency: 'PKR' },
    },
    user: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        deniedScope === 'actor' || where.organizationId !== organizationId
          ? null
          : {
              id: where.id,
              role: 'ADMIN',
              department: 'LEADERSHIP',
              status: deniedScope === 'inactive' ? 'SUSPENDED' : 'ACTIVE',
            },
      findUnique: async () => ({
        id: 'actor-a',
        organizationId,
        role: 'ADMIN',
        status: deniedScope === 'inactive' ? 'SUSPENDED' : 'ACTIVE',
        organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
        permissionOverrides: deny ? [{ capability: deny, effect: 'DENY' }] : [],
      }),
    },
    pharmacyBranch: {
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; id: string; active: boolean };
      }) =>
        deniedScope === 'branch' ||
        where.organizationId !== organizationId ||
        !where.active ||
        !where.id.startsWith('branch-')
          ? null
          : { id: where.id },
    },
    pharmacyBranchAssignment: {
      findFirst: async ({ where }: { where: { active: boolean; organizationId: string } }) =>
        deniedScope === 'assignment' || !where.active || where.organizationId !== organizationId
          ? null
          : { id: 'assignment' },
    },
    pharmacyCustomer: {
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; active: boolean; id: string };
      }) =>
        deniedScope === 'customer' || !where.active || where.organizationId !== organizationId
          ? null
          : { id: where.id },
    },
    pharmacySaleLine: {
      findMany: async () => [{ quantity: 1, unitPriceMinor: saleTotal, discountMinor: 0 }],
    },
    pharmacyTender: { aggregate: async () => ({ _sum: { amountMinor: otherTenders } }) },
    financeJournalEntry: {
      findMany: async ({
        where,
      }: {
        where: {
          organizationId: string;
          OR: [{ sourceKind: string; sourceId: string }, { idempotencyKey: string }];
        };
      }) =>
        state.canonical.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            ((row.sourceKind === where.OR[0].sourceKind && row.sourceId === where.OR[0].sourceId) ||
              row.idempotencyKey === where.OR[1].idempotencyKey)
        ),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => canonicalFind(where),
      findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) =>
        canonicalFind(where) ?? Promise.reject(new Error('missing canonical')),
      create: async ({
        data,
      }: {
        data: Omit<Canonical, 'id' | 'lines' | 'reversesEntryId' | 'reversalReason'>;
      }) => {
        inject('canonical-header');
        const row: Canonical = {
          ...data,
          id: `canonical-${++state.sequence}`,
          reversesEntryId: null,
          reversalReason: null,
          lines: [],
        };
        state.canonical.push(row);
        return row;
      },
    },
    financeJournalLine: {
      create: async ({ data }: { data: CanonicalLine }) => {
        const parent = state.canonical.find((row) => row.id === data.entryId)!;
        inject(`canonical-line-${parent.lines.length + 1}`);
        parent.lines.push(data);
        return data;
      },
    },
    $queryRaw: async (query: Sql) => {
      const text = query.sql;
      const v = query.values;
      if (text.includes('pg_advisory_xact_lock')) return [];
      if (text.includes('FROM stored_value_accounts'))
        return state.accounts.filter(
          (row) =>
            row.organizationId === organizationId &&
            row.organizationId === v[0] &&
            v.slice(1).includes(row.id)
        );
      if (text.includes('INSERT INTO stored_value_journals')) {
        inject('subledger-header');
        const [
          id,
          org,
          branchId,
          kind,
          idempotencyKey,
          saleId,
          actorId,
          tender,
          reason,
          currency,
          originalJournalId,
        ] = v;
        if (
          state.journals.some(
            (row) =>
              row.id === id || (row.organizationId === org && row.idempotencyKey === idempotencyKey)
          )
        )
          throw new Error('unique journal');
        const row = {
          id,
          organizationId: org,
          branchId,
          kind,
          idempotencyKey,
          saleId,
          actorId,
          tender,
          reason,
          currency,
          originalJournalId,
          occurredAt: new Date(1_800_000_000_000 + ++state.sequence),
        } as Journal;
        state.journals.push(row);
        return [row];
      }
      if (text.includes('FROM stored_value_journals WHERE'))
        return state.journals.filter(
          (row) =>
            row.organizationId === organizationId &&
            row.organizationId === v[0] &&
            (text.includes('"idempotencyKey"=')
              ? row.idempotencyKey === v[1] || row.id === v[2]
              : row.id === v[1])
        );
      if (text.includes('FROM stored_value_entries\n') && text.includes('ORDER BY id'))
        return state.entries.filter(
          (row) =>
            row.organizationId === organizationId &&
            row.organizationId === v[0] &&
            row.journalId === v[1]
        );
      if (text.includes('FROM pharmacy_sales'))
        return deniedScope === 'sale' ||
          v[0] !== organizationId ||
          !String(v[1]).startsWith('branch-') ||
          v[2] !== 'sale-1'
          ? []
          : [{ id: 'sale-1', customerId: saleCustomer, status: saleStatus }];
      if (text.includes('FROM pharmacy_wallet_settings'))
        return [{ allowUnusedRefund: refundAllowed }];
      if (text.includes('AS "spentMinor"')) {
        const total = state.entries
          .filter(
            (entry) =>
              entry.organizationId === organizationId &&
              entry.organizationId === v[0] &&
              entry.accountId === v[1] &&
              entry.amountMinor < 0
          )
          .filter((entry) => {
            const journal = state.journals.find((row) => row.id === entry.journalId)!;
            return v.length === 4
              ? journal.branchId === v[2] && journal.saleId === v[3] && journal.kind === 'SPEND'
              : true;
          })
          .reduce((sum, row) => sum - row.amountMinor, 0);
        return [{ spentMinor: BigInt(total) }];
      }
      throw new Error(`Unhandled model SQL: ${text}`);
    },
    $executeRaw: async (query: Sql) => {
      const v = query.values;
      if (query.sql.includes('UPDATE stored_value_accounts')) {
        inject('balance');
        const row = state.accounts.find(
          (item) =>
            item.organizationId === organizationId &&
            item.organizationId === v[1] &&
            item.id === v[2]
        );
        if (!row || row.balanceMinor + Number(v[0]) < 0) return 0;
        row.balanceMinor += Number(v[0]);
        return 1;
      }
      if (query.sql.includes('INSERT INTO stored_value_entries')) {
        inject('subledger-entries');
        for (let i = 0; i < v.length; i += 5)
          state.entries.push({
            id: v[i],
            organizationId: v[i + 1],
            journalId: v[i + 2],
            accountId: v[i + 3],
            amountMinor: v[i + 4],
          } as Entry);
        return 2;
      }
      throw new Error(`Unhandled model write: ${query.sql}`);
    },
  };
  return db as unknown as ScopedDb;
}

beforeEach(() => {
  const accounts: Account[] = ['a', 'b'].flatMap((tenant) => [
    {
      id: `wallet-${tenant}`,
      organizationId: `tenant-${tenant}`,
      customerId: `customer-${tenant}`,
      kind: 'CUSTOMER_LIABILITY',
      currency: 'PKR',
      balanceMinor: 1000,
    },
    {
      id: `cash-${tenant}`,
      organizationId: `tenant-${tenant}`,
      customerId: null,
      kind: 'CASH_CLEARING',
      currency: 'PKR',
      balanceMinor: 0,
    },
    {
      id: `sale-${tenant}`,
      organizationId: `tenant-${tenant}`,
      customerId: null,
      kind: 'SALES_CLEARING',
      currency: 'PKR',
      balanceMinor: 0,
    },
  ]);
  state = { accounts, journals: [], entries: [], canonical: [], sequence: 0 };
  failAt = deny = deniedScope = null;
  refundAllowed = false;
  saleCustomer = 'customer-a';
  saleStatus = 'OPEN';
  saleTotal = 2000;
  otherTenders = 0;
  queue = Promise.resolve();
  transaction.run = (organizationId, fn) => {
    // Serialization here is ONLY a model; a PG race test is a separate QA gate.
    const run = queue.then(async () => {
      const snapshot = structuredClone(state);
      try {
        return await fn(dbFor(organizationId));
      } catch (error) {
        state = snapshot;
        throw error;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
});

describe('funded wallet canonical bridge — transactional model, not PostgreSQL', () => {
  it.each(['CASH', 'BANK_TRANSFER'] as const)(
    'TOP_UP records %s asset against CREDIT-normal liability, never revenue/expense',
    async (tender) => {
      await postPharmacyStoredValue(scope, topup({ tender }));
      expect(balance()).toBe(1200);
      expect(state.entries.map((row) => row.amountMinor)).toEqual([200, -200]);
      expect(state.canonical).toHaveLength(1);
      expect(state.canonical[0]).toMatchObject({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        currency: 'PKR',
        sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL',
        sourceId: 'topup-a',
      });
      expect(
        state.canonical[0].lines.map(({ accountCode, side, amountMinor }) => ({
          accountCode,
          side,
          amountMinor,
        }))
      ).toEqual([
        { accountCode: 'CUSTOMER_WALLET_LIABILITY', side: 'CREDIT', amountMinor: 200 },
        { accountCode: tender === 'CASH' ? 'CASH' : 'BANK', side: 'DEBIT', amountMinor: 200 },
      ]);
      expect(ACCOUNT_NORMAL_SIDE.CUSTOMER_WALLET_LIABILITY).toBe('CREDIT');
      expect(
        signedMinor({ accountCode: 'CUSTOMER_WALLET_LIABILITY', side: 'CREDIT', amountMinor: 200 })
      ).toBe(200);
    }
  );
  it('SPEND debits liability and credits existing SALES_CLEARING, without repeating revenue', async () => {
    await postPharmacyStoredValue(scope, spend());
    expect(balance()).toBe(800);
    expect(state.entries.map((row) => row.amountMinor)).toEqual([-200, 200]);
    expect(state.canonical[0].lines.map((row) => [row.accountCode, row.side])).toEqual([
      ['CUSTOMER_WALLET_LIABILITY', 'DEBIT'],
      ['SALES_CLEARING', 'CREDIT'],
    ]);
  });
  it('exact retry is no-op even after a later spend changes the balance', async () => {
    await postPharmacyStoredValue(scope, topup());
    await postPharmacyStoredValue(scope, spend());
    const snapshot = structuredClone(state);
    expect(await postPharmacyStoredValue(scope, topup())).toMatchObject({
      replayed: true,
      balanceDeltaMinor: 0,
    });
    expect(state).toEqual(snapshot);
  });
  it.each([
    ['amount', { amountMinor: 201 }],
    ['key', { idempotencyKey: 'other-key' }],
    ['journal', { journalId: 'other-journal' }],
    ['reason', { reason: 'changed' }],
    ['tender', { tender: 'BANK_TRANSFER' }],
  ])('rejects conflicting retry %s without changing any state', async (_name, changes) => {
    await postPharmacyStoredValue(scope, topup());
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, topup(changes))).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(state).toEqual(snapshot);
  });
  it.each(['branchId', 'actorId'] as const)('binds retry to immutable %s', async (field) => {
    await postPharmacyStoredValue(scope, topup());
    const snapshot = structuredClone(state);
    await expect(
      postPharmacyStoredValue(
        { ...scope, [field]: field === 'branchId' ? 'branch-other' : 'manager-other' },
        topup()
      )
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(state).toEqual(snapshot);
  });
  it('same client key in another tenant with distinct server journal does not share value', async () => {
    await postPharmacyStoredValue(scope, topup());
    await postPharmacyStoredValue(
      { ...scope, organizationId: 'tenant-b', branchId: 'branch-b' },
      topup({ journalId: 'topup-b', accountId: 'wallet-b', counterpartyAccountId: 'cash-b' })
    );
    expect(state.journals).toHaveLength(2);
    expect(state.canonical.map((row) => row.organizationId)).toEqual(['tenant-a', 'tenant-b']);
    expect(state.accounts.find((row) => row.id === 'wallet-b')!.balanceMinor).toBe(1200);
  });
  it.each(['wallet-b', 'cash-b'])(
    'refuses foreign-tenant account %s before mutation',
    async (account) => {
      const snapshot = structuredClone(state);
      await expect(
        postPharmacyStoredValue(
          scope,
          topup(
            account.startsWith('wallet')
              ? { accountId: account }
              : { counterpartyAccountId: account }
          )
        )
      ).rejects.toThrow('WALLET_ACCOUNT_SCOPE');
      expect(state).toEqual(snapshot);
    }
  );
  it.each(['organizationId', 'branchId', 'actorId'] as const)(
    'rejects omitted %s instead of allowing omitted Prisma predicates',
    async (field) => {
      const snapshot = structuredClone(state);
      await expect(
        postPharmacyStoredValue(
          { ...scope, [field]: undefined } as unknown as StoredValuePostingScope,
          topup()
        )
      ).rejects.toThrow('WALLET_SCOPE_DENIED');
      expect(state).toEqual(snapshot);
    }
  );
  it.each(['tenant', 'actor', 'inactive', 'branch', 'assignment', 'customer'])(
    'denies invalid %s including ADMIN without bypass',
    async (field) => {
      deniedScope = field;
      const snapshot = structuredClone(state);
      await expect(postPharmacyStoredValue(scope, topup())).rejects.toThrow(
        /WALLET_SCOPE_DENIED|WALLET_ACCOUNT_SCOPE/
      );
      expect(state).toEqual(snapshot);
    }
  );
  it.each([
    ['pharmacy:wallet-topup', () => topup()],
    ['pharmacy:counter', () => spend()],
  ] as const)('respects canonical DENY for %s', async (capability, command) => {
    deny = capability;
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, command())).rejects.toThrow(
      'WALLET_PERMISSION_DENIED'
    );
    expect(state).toEqual(snapshot);
  });
  it('refuses currency mismatch without changing balances', async () => {
    state.accounts[0].currency = 'USD';
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, topup())).rejects.toThrow(
      'WALLET_CURRENCY_MISMATCH'
    );
    expect(state).toEqual(snapshot);
  });
  it('refuses organization currency spoofing', async () => {
    await expect(postPharmacyStoredValue({ ...scope, currency: 'USD' }, topup())).rejects.toThrow(
      'WALLET_CURRENCY_MISMATCH'
    );
    expect(state.journals).toHaveLength(0);
  });
  it.each([
    'balance',
    'subledger-header',
    'subledger-entries',
    'canonical-header',
    'canonical-line-1',
    'canonical-line-2',
  ])(
    'injected %s failure rolls back cache + business source + both ledgers in the model',
    async (stage) => {
      failAt = stage;
      const snapshot = structuredClone(state);
      await expect(postPharmacyStoredValue(scope, topup())).rejects.toThrow(`injected:${stage}`);
      expect(state).toEqual(snapshot);
    }
  );
  it('no overdraft changes no evidence', async () => {
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, spend({ amountMinor: 1001 }))).rejects.toThrow(
      'INSUFFICIENT_BALANCE'
    );
    expect(state).toEqual(snapshot);
  });
  it('serialized competing spends permit only one in the model (PG race remains untested)', async () => {
    const results = await Promise.allSettled([
      postPharmacyStoredValue(scope, spend({ amountMinor: 700 })),
      postPharmacyStoredValue(
        scope,
        spend({ journalId: 'spend-b', idempotencyKey: 'spend-b', amountMinor: 700 })
      ),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(balance()).toBe(300);
    expect(state.journals).toHaveLength(1);
    expect(state.canonical).toHaveLength(1);
  });
  it.each(['VOID', 'QUOTATION'])('refuses %s sale', async (status) => {
    saleStatus = status;
    await expect(postPharmacyStoredValue(scope, spend())).rejects.toThrow('WALLET_SALE_SCOPE');
    expect(state.journals).toHaveLength(0);
  });
  it('refuses wrong sale customer', async () => {
    saleCustomer = 'someone-else';
    await expect(postPharmacyStoredValue(scope, spend())).rejects.toThrow('WALLET_SALE_SCOPE');
  });
  it('caps sale funding including earlier tenders and wallet spends', async () => {
    saleTotal = 400;
    otherTenders = 100;
    await postPharmacyStoredValue(scope, spend());
    const snapshot = structuredClone(state);
    await expect(
      postPharmacyStoredValue(scope, spend({ journalId: 'extra', idempotencyKey: 'extra' }))
    ).rejects.toThrow('WALLET_SALE_ALREADY_FUNDED');
    expect(state).toEqual(snapshot);
  });
  it('blocks unused TOP_UP payout even with original BANK funding, permission and enabled setting', async () => {
    await postPharmacyStoredValue(scope, topup({ tender: 'BANK_TRANSFER' }));
    refundAllowed = true;
    const snapshot = structuredClone(state);
    await expect(
      postPharmacyStoredValue({ ...scope, actorId: 'manager-a' }, refund())
    ).rejects.toThrow('WALLET_REFUND_NOT_APPROVED');
    expect(state).toEqual(snapshot);
  });
  it('disabled refunds roll back/no-op', async () => {
    await postPharmacyStoredValue(scope, topup());
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, refund())).rejects.toThrow(
      'WALLET_REFUND_NOT_APPROVED'
    );
    expect(state).toEqual(snapshot);
  });
  it('later deposits cannot replenish refundable original provenance', async () => {
    await postPharmacyStoredValue(scope, topup());
    await postPharmacyStoredValue(scope, spend({ amountMinor: 200 }));
    await postPharmacyStoredValue(
      scope,
      topup({ journalId: 'later-deposit', idempotencyKey: 'later-deposit', amountMinor: 500 })
    );
    refundAllowed = true;
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, refund())).rejects.toThrow(
      'WALLET_REFUND_NOT_APPROVED'
    );
    expect(state).toEqual(snapshot);
  });
  it('cannot hide consumption with an earlier transaction-start timestamp', async () => {
    await postPharmacyStoredValue(scope, topup());
    await postPharmacyStoredValue(scope, spend({ amountMinor: 200 }));
    state.journals.find((row) => row.id === 'spend-a')!.occurredAt = new Date(0);
    await postPharmacyStoredValue(
      scope,
      topup({ journalId: 'replenish', idempotencyKey: 'replenish', amountMinor: 500 })
    );
    refundAllowed = true;
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, refund())).rejects.toThrow(
      'WALLET_REFUND_NOT_APPROVED'
    );
    expect(state).toEqual(snapshot);
  });
  it('blocks repeated refund attempts rather than accepting a key as policy approval', async () => {
    await postPharmacyStoredValue(scope, topup());
    refundAllowed = true;
    const snapshot = structuredClone(state);
    for (let i = 0; i < 2; i++)
      await expect(postPharmacyStoredValue(scope, refund())).rejects.toThrow(
        'WALLET_REFUND_NOT_APPROVED'
      );
    expect(state).toEqual(snapshot);
  });
  it('rejects incompatible sale currency before opening a transaction', async () => {
    const run = vi.fn(transaction.run);
    transaction.run = run;
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue({ ...scope, currency: 'USD' }, spend())).rejects.toThrow(
      'WALLET_CURRENCY_MISMATCH'
    );
    expect(run).not.toHaveBeenCalled();
    expect(state).toEqual(snapshot);
  });
  it('rejects refunds at the same-transaction boundary without accessing its database', async () => {
    const { postPharmacyStoredValueInTransaction } = await import('./stored-value-finance');
    const forbiddenDb = new Proxy(
      {},
      {
        get() {
          throw new Error('unexpected database access');
        },
      }
    ) as ScopedDb;
    await expect(
      postPharmacyStoredValueInTransaction(forbiddenDb, scope, refund())
    ).rejects.toThrow('WALLET_REFUND_NOT_APPROVED');
    await expect(
      postPharmacyStoredValueInTransaction(forbiddenDb, { ...scope, currency: 'USD' }, spend())
    ).rejects.toThrow('WALLET_CURRENCY_MISMATCH');
  });
  it('unproven sale-funded refund fails closed, not credited as cash', async () => {
    await postPharmacyStoredValue(scope, spend());
    refundAllowed = true;
    const snapshot = structuredClone(state);
    await expect(
      postPharmacyStoredValue(scope, refund({ originalJournalId: 'spend-a' }))
    ).rejects.toThrow('WALLET_REFUND_NOT_APPROVED');
    expect(state).toEqual(snapshot);
  });
  it.each([
    'missing',
    'duplicate',
    'amount',
    'branch',
    'currency',
    'source',
    'actor',
    'line-source',
    'reversed',
  ])('rejects %s canonical retry evidence without repairing/backfilling', async (change) => {
    await postPharmacyStoredValue(scope, topup());
    const row = state.canonical[0];
    if (change === 'missing') state.canonical = [];
    if (change === 'duplicate')
      state.canonical.push({
        ...structuredClone(row),
        id: 'duplicate',
        idempotencyKey: 'duplicate-key',
      });
    if (change === 'amount') row.lines[0].amountMinor++;
    if (change === 'branch') row.branchId = 'other';
    if (change === 'currency') row.currency = 'USD';
    if (change === 'source') row.sourceId = 'other';
    if (change === 'actor') row.actorId = 'other';
    if (change === 'line-source') row.lines[0].sourceLineId = 'other';
    if (change === 'reversed') row.reversesEntryId = 'other';
    const snapshot = structuredClone(state);
    await expect(postPharmacyStoredValue(scope, topup())).rejects.toThrow(
      'WALLET_CANONICAL_CONFLICT'
    );
    expect(state).toEqual(snapshot);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    'refuses invalid minor amount %s before mutation',
    async (amountMinor) => {
      const snapshot = structuredClone(state);
      await expect(postPharmacyStoredValue(scope, topup({ amountMinor }))).rejects.toThrow();
      expect(state).toEqual(snapshot);
    }
  );
  it.each(['EXPIRY', 'ADJUSTMENT', 'SALE_REFUND'])('unsupported %s fails closed', async (kind) => {
    const command = { ...topup(), kind } as PharmacyStoredValueCommand;
    await expect(postPharmacyStoredValue(scope, command)).rejects.toThrow(
      'WALLET_UNSUPPORTED_KIND'
    );
    expect(state.journals).toHaveLength(0);
  });
});

/** Owned clearing is corrupt even if its kind/currency and both balances agree. */
describe('writer refuses customer-owned clearing before mutation or replay', () => {
  const cases = [
    ['TOP_UP CASH', () => topup()],
    ['TOP_UP BANK_TRANSFER', () => topup({ tender: 'BANK_TRANSFER' })],
    ['SPEND SALES_CLEARING', () => spend()],
  ] as const;
  function primitive(command: PharmacyStoredValueCommand) {
    return {
      ...scope,
      ...command,
      direction: command.kind === 'SPEND' ? ('DEBIT' as const) : ('CREDIT' as const),
      tender: command.kind === 'TOP_UP' ? command.tender : undefined,
    };
  }
  for (const replay of [false, true]) {
    for (const boundary of ['facade', 'in-transaction', 'primitive'] as const) {
      it.each(cases)(
        `%s owned clearing: ${boundary}, replay=${replay}, no effects`,
        async (_label, make) => {
          const command = make();
          const db = dbFor(scope.organizationId);
          const post = () =>
            boundary === 'facade'
              ? postPharmacyStoredValue(scope, command)
              : boundary === 'in-transaction'
                ? postPharmacyStoredValueInTransaction(db, scope, command)
                : postStoredValueJournal(db, primitive(command));
          if (replay) await post();
          state.accounts.find((row) => row.id === command.counterpartyAccountId)!.customerId =
            'customer-a';
          const before = structuredClone(state);
          await expect(post()).rejects.toThrow(
            boundary === 'primitive' ? 'INVALID_ACCOUNT' : 'WALLET_ACCOUNT_SCOPE'
          );
          expect(state).toEqual(before);
        }
      );
    }
  }
  it.each(cases)(
    '%s primitive accepts exactly NULL clearing and exact retry is inert',
    async (_label, make) => {
      const command = make();
      const db = dbFor(scope.organizationId);
      await expect(postStoredValueJournal(db, primitive(command))).resolves.toMatchObject({
        replayed: false,
      });
      expect(state.journals).toHaveLength(1);
      expect(state.entries).toHaveLength(2);
      const before = structuredClone(state);
      await expect(postStoredValueJournal(db, primitive(command))).resolves.toMatchObject({
        replayed: true,
        balanceDeltaMinor: 0,
      });
      expect(state).toEqual(before);
    }
  );
  it.each(['', undefined])(
    'does not confuse missing/empty ownership with SQL NULL: %s',
    async (owner) => {
      state.accounts.find((row) => row.id === 'cash-a')!.customerId = owner as string;
      const before = structuredClone(state);
      await expect(
        postPharmacyStoredValueInTransaction(dbFor(scope.organizationId), scope, topup())
      ).rejects.toThrow('WALLET_ACCOUNT_SCOPE');
      await expect(
        postStoredValueJournal(dbFor(scope.organizationId), primitive(topup()))
      ).rejects.toThrow('INVALID_ACCOUNT');
      expect(state).toEqual(before);
    }
  );
});
