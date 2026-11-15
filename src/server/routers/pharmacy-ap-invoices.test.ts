import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  hasModule: vi.fn(),
  branchFindFirst: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn(),
  record: vi.fn(),
  pay: vi.fn(),
  reverseSettlement: vi.fn(),
  reverseInvoice: vi.fn(),
  list: vi.fn(),
  aging: vi.fn(),
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
vi.mock('@/lib/pharmacy/accounts/ap-invoices', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/ap-invoices')>(
    '@/lib/pharmacy/accounts/ap-invoices'
  )),
  recordApInvoice: mocks.record,
  payApInvoice: mocks.pay,
  reverseApSettlement: mocks.reverseSettlement,
  reverseApInvoice: mocks.reverseInvoice,
  listApInvoices: mocks.list,
}));
vi.mock('@/lib/pharmacy/accounts/ap-aging', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/ap-aging')>(
    '@/lib/pharmacy/accounts/ap-aging'
  )),
  readApAging: mocks.aging,
}));

import { PharmacyApInvoiceError } from '@/lib/pharmacy/accounts/ap-invoices';
import { moduleForPath, moduleForProcedure } from '@/lib/module-catalog';
import type { TRPCContext } from '../trpc';
import { pharmacyApInvoicesRouter } from './pharmacy-ap-invoices';

const TX = { tx: true };

function caller(context: Partial<TRPCContext> = {}) {
  return pharmacyApInvoicesRouter.createCaller({
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
const recordInput = {
  branchId: 'branch_1',
  createKey: 'create-key-0001',
  reference: 'AP-1',
  payeeName: 'K-Electric',
  supplierInvoiceRef: 'KE-11',
  invoiceDate: '2026-11-01',
  dueDate: '2026-11-20',
  amountMinor: 100,
  currency: 'PKR' as const,
  description: 'Electricity',
  evidenceReference: 'Bill',
};
const payInput = {
  branchId: 'branch_1',
  invoiceId: 'inv_1',
  commandKey: 'pay-key-0001',
  reference: 'PAY-1',
  amountMinor: 100,
  paidAt: '2026-11-10T00:00:00.000Z',
  fundingAccount: 'CASH' as const,
};
const reverseSettlementInput = {
  branchId: 'branch_1',
  settlementId: 'set_1',
  commandKey: 'rev-pay-0001',
  reason: 'Bounced',
  at: '2026-11-12T00:00:00.000Z',
};
const reverseInvoiceInput = {
  branchId: 'branch_1',
  invoiceId: 'inv_1',
  commandKey: 'rev-inv-0001',
  reason: 'Duplicate',
  at: '2026-11-12T00:00:00.000Z',
};
const invoice = {
  id: 'inv_1',
  reference: 'AP-1',
  status: 'POSTED',
  amountMinor: 100,
  journalEntryId: 'entry_1',
  reversalEntryId: null,
};
const settlement = {
  id: 'set_1',
  invoiceId: 'inv_1',
  transactionId: 'txn_1',
  amountMinor: 100,
  status: 'ACTIVE',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(TX));
  mocks.recordAudit.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue({ invoice, replayed: false });
  mocks.pay.mockResolvedValue({ settlement, replayed: false });
  mocks.reverseSettlement.mockResolvedValue({
    settlement: { ...settlement, status: 'REVERSED' },
    replayed: false,
  });
  mocks.reverseInvoice.mockResolvedValue({
    invoice: { ...invoice, status: 'REVERSED', reversalEntryId: 'entry_rev' },
    replayed: false,
  });
  mocks.list.mockResolvedValue([]);
  mocks.aging.mockResolvedValue({
    asOf: '2026-11-15',
    complete: true,
    scannedInvoices: 0,
    rows: [],
    totals: [],
  });
});

describe('pharmacyApInvoices router — registration', () => {
  it('licenses the namespace and the aging page as Pharmacy Finance', () => {
    expect(moduleForProcedure('pharmacyApInvoices.pay')).toBe('pharmacy-finance');
    expect(moduleForPath('/pharmacy/accounts/ap-aging')).toBe('pharmacy-finance');
  });

  it('is mounted on the root router', async () => {
    const { appRouter } = await import('./_app');
    expect(Object.keys(appRouter._def.procedures)).toEqual(
      expect.arrayContaining([
        'pharmacyApInvoices.record',
        'pharmacyApInvoices.pay',
        'pharmacyApInvoices.reverseSettlement',
        'pharmacyApInvoices.reverseInvoice',
        'pharmacyApInvoices.list',
        'pharmacyApInvoices.aging',
      ])
    );
    // Importing the whole root router is slow on a cold transform cache.
  }, 60_000);
});

describe('pharmacyApInvoices router — authorization before access', () => {
  it.each([
    ['record', () => caller().record(recordInput), mocks.record],
    ['pay', () => caller().pay(payInput), mocks.pay],
    [
      'reverseSettlement',
      () => caller().reverseSettlement(reverseSettlementInput),
      mocks.reverseSettlement,
    ],
    ['reverseInvoice', () => caller().reverseInvoice(reverseInvoiceInput), mocks.reverseInvoice],
    ['list', () => caller().list({ branchId: 'branch_1' }), mocks.list],
    ['aging', () => caller().aging({ branchId: 'branch_1', asOf: '2026-11-15' }), mocks.aging],
  ] as const)('refuses %s without the finance licence', async (_name, call, domain) => {
    mocks.hasModule.mockReturnValue(false);
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(domain).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses a non-owner before any AP access', async () => {
    await expect(
      caller({
        session: {
          expires: 'later',
          user: { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
        },
      } as never).pay(payInput)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.pay).not.toHaveBeenCalled();
  });

  it('refuses when the finance ABAC decision is denied', async () => {
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action !== 'finance:read'
    );
    await expect(caller().record(recordInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('refuses an inactive or foreign branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(
      caller().aging({ branchId: 'branch_x', asOf: '2026-11-15' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.aging).not.toHaveBeenCalled();
  });

  it('rejects malformed input before authorization or access', async () => {
    await expect(caller().pay({ ...payInput, amountMinor: -5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().record({ ...recordInput, invoiceDate: 'yesterday' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.pay).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe('pharmacyApInvoices router — atomic audit', () => {
  it.each([
    [
      'record',
      () => caller().record(recordInput),
      mocks.record,
      recordInput,
      'pharmacyApInvoices.record',
      'inv_1',
    ],
    ['pay', () => caller().pay(payInput), mocks.pay, payInput, 'pharmacyApInvoices.pay', 'set_1'],
    [
      'reverseSettlement',
      () => caller().reverseSettlement(reverseSettlementInput),
      mocks.reverseSettlement,
      reverseSettlementInput,
      'pharmacyApInvoices.reverseSettlement',
      'set_1',
    ],
    [
      'reverseInvoice',
      () => caller().reverseInvoice(reverseInvoiceInput),
      mocks.reverseInvoice,
      reverseInvoiceInput,
      'pharmacyApInvoices.reverseInvoice',
      'inv_1',
    ],
  ] as const)(
    '%s runs the command and its EXECUTE audit in one transaction',
    async (_name, call, domain, input, action, targetId) => {
      await call();
      expect(domain).toHaveBeenCalledWith(TX, scope, input);
      expect(mocks.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'EXECUTE', action, targetId, outcome: 'SUCCESS' }),
        TX
      );
    }
  );

  it('fails the command when the transactional audit fails', async () => {
    mocks.recordAudit.mockRejectedValue(new Error('audit write failed'));
    await expect(caller().pay(payInput)).rejects.toThrow('audit write failed');
  });
});

describe('pharmacyApInvoices router — error mapping', () => {
  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['OVERPAYMENT', 'CONFLICT'],
    ['ACTIVE_SETTLEMENTS', 'CONFLICT'],
    ['DUPLICATE_INVOICE', 'CONFLICT'],
    ['IDEMPOTENCY_CONFLICT', 'CONFLICT'],
    ['PERIOD_CLOSED', 'BAD_REQUEST'],
    ['INVALID_DATE', 'BAD_REQUEST'],
  ] as const)('maps %s to %s', async (reason, code) => {
    mocks.pay.mockRejectedValue(new PharmacyApInvoiceError(reason));
    await expect(caller().pay(payInput)).rejects.toMatchObject({ code, message: reason });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('maps an invalid as-of day on the aging read', async () => {
    mocks.aging.mockRejectedValue(new PharmacyApInvoiceError('INVALID_DATE'));
    await expect(
      caller().aging({ branchId: 'branch_1', asOf: '2026-11-15' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
