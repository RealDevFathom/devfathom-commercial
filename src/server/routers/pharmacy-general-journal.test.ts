import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  hasModule: vi.fn(),
  branchFindFirst: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  cancelDraft: vi.fn(),
  post: vi.fn(),
  reverse: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  recordAudit: mocks.recordAudit,
}));
vi.mock('@/lib/pharmacy/accounts/general-journal', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/general-journal')>(
    '@/lib/pharmacy/accounts/general-journal'
  )),
  createJournalVoucherDraft: mocks.createDraft,
  updateJournalVoucherDraft: mocks.updateDraft,
  cancelJournalVoucherDraft: mocks.cancelDraft,
  postJournalVoucher: mocks.post,
  reverseJournalVoucher: mocks.reverse,
  listJournalVouchers: mocks.list,
  getJournalVoucher: mocks.get,
}));

import { PharmacyJournalVoucherError } from '@/lib/pharmacy/accounts/general-journal';
import { moduleForPath, moduleForProcedure } from '@/lib/module-catalog';
import type { TRPCContext } from '../trpc';
import { pharmacyGeneralJournalRouter } from './pharmacy-general-journal';
// Loaded with the file (as restaurant-growth.test.ts does) so building the whole
// root router is not timed against a single test's 5 s budget under a loaded run.
import { appRouter } from './_app';

const TX = { tx: true };

function caller(context: Partial<TRPCContext> = {}) {
  return pharmacyGeneralJournalRouter.createCaller({
    db: {
      $transaction: mocks.transaction,
      pharmacyBranch: { findFirst: mocks.branchFindFirst },
    },
    entitlements: { organizationId: 'org_1', enabledModules: ['pharmacy-finance'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    ...context,
  } as unknown as TRPCContext);
}

const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };
const draft = {
  branchId: 'branch_1',
  createKey: 'create-key-0001',
  reference: 'JV-1',
  purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
  occurredAt: '2026-11-10T09:00:00.000Z',
  reason: 'Electricity accrual',
  evidenceReference: 'Bill 2026-11',
  lines: [
    { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 100 },
    { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT' as const, amountMinor: 100 },
  ],
};
const postInput = {
  branchId: 'branch_1',
  voucherId: 'jv_1',
  expectedVersion: 1,
  commandKey: 'post-key-0001',
};
const reverseInput = {
  branchId: 'branch_1',
  voucherId: 'jv_1',
  commandKey: 'reverse-key-0001',
  reason: 'Wrong branch',
  at: '2026-11-12T00:00:00.000Z',
};
const posted = {
  id: 'jv_1',
  reference: 'JV-1',
  version: 1,
  status: 'POSTED',
  journalEntryId: 'entry_1',
  reversalEntryId: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(TX));
  mocks.recordAudit.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue({ voucher: posted, replayed: false });
  mocks.reverse.mockResolvedValue({
    voucher: { ...posted, status: 'REVERSED', reversalEntryId: 'entry_rev' },
    replayed: false,
  });
});

describe('pharmacyGeneralJournal router — registration', () => {
  it('licenses the namespace and the page as Pharmacy Finance', () => {
    expect(moduleForProcedure('pharmacyGeneralJournal.post')).toBe('pharmacy-finance');
    expect(moduleForPath('/pharmacy/accounts/general-journal')).toBe('pharmacy-finance');
  });

  it('is mounted on the root router', () => {
    expect(Object.keys(appRouter._def.procedures)).toEqual(
      expect.arrayContaining([
        'pharmacyGeneralJournal.post',
        'pharmacyGeneralJournal.reverse',
        'pharmacyGeneralJournal.createDraft',
        'pharmacyGeneralJournal.list',
      ])
    );
  });
});

describe('pharmacyGeneralJournal router — authorization before access', () => {
  it.each([
    ['post', () => caller().post(postInput), mocks.post],
    ['reverse', () => caller().reverse(reverseInput), mocks.reverse],
    ['createDraft', () => caller().createDraft(draft), mocks.createDraft],
    ['list', () => caller().list({ branchId: 'branch_1' }), mocks.list],
  ] as const)(
    'refuses %s on a prefixless caller without the finance licence',
    async (_name, call, domain) => {
      mocks.hasModule.mockReturnValue(false);
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(domain).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a non-owner before any voucher access', async () => {
    await expect(
      caller({
        session: {
          expires: 'later',
          user: { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
        },
      } as never).post(postInput)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuses when the finance ABAC decision is denied', async () => {
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action !== 'finance:read'
    );
    await expect(caller().post(postInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuses an inactive branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(caller().reverse(reverseInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reverse).not.toHaveBeenCalled();
  });

  it('rejects disallowed input shapes before authorization or access', async () => {
    await expect(
      caller().createDraft({ ...draft, purpose: 'TRADE' as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});

describe('pharmacyGeneralJournal router — atomic audit', () => {
  it('posts and writes the EXECUTE audit through the same transaction', async () => {
    await expect(caller().post(postInput)).resolves.toEqual(posted);
    expect(mocks.post).toHaveBeenCalledWith(TX, scope, postInput);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'EXECUTE',
        action: 'pharmacyGeneralJournal.post',
        targetId: 'jv_1',
        result: expect.objectContaining({ entryId: 'entry_1' }),
      }),
      TX
    );
  });

  it('reverses and writes the EXECUTE audit through the same transaction', async () => {
    await caller().reverse(reverseInput);
    expect(mocks.reverse).toHaveBeenCalledWith(TX, scope, reverseInput);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacyGeneralJournal.reverse',
        result: expect.objectContaining({ entryId: 'entry_rev' }),
      }),
      TX
    );
  });

  it('fails the command when the transactional audit fails', async () => {
    mocks.recordAudit.mockRejectedValue(new Error('audit write failed'));
    await expect(caller().post(postInput)).rejects.toThrow('audit write failed');
  });
});

describe('pharmacyGeneralJournal router — error mapping', () => {
  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['STALE_VERSION', 'CONFLICT'],
    ['ALREADY_POSTED', 'CONFLICT'],
    ['IDEMPOTENCY_CONFLICT', 'CONFLICT'],
    ['INVALID_LINES', 'BAD_REQUEST'],
    ['PERIOD_CLOSED', 'BAD_REQUEST'],
  ] as const)('maps %s to %s', async (reason, code) => {
    mocks.post.mockRejectedValue(new PharmacyJournalVoucherError(reason));
    await expect(caller().post(postInput)).rejects.toMatchObject({ code, message: reason });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
