import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  creditFindMany: vi.fn(),
  mayManage: vi.fn(),
  pin: vi.fn(),
  requestSetOff: vi.fn(),
  approveSetOff: vi.fn(),
  rejectSetOff: vi.fn(),
  listSetOffs: vi.fn(),
  soleApprover: vi.fn(),
  setOffGroupBy: vi.fn(),
  reverseSetOff: vi.fn(),
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
vi.mock('@/lib/pharmacy/refund-authorization', () => ({
  actorMayRefund: mocks.mayManage,
  authenticateRefundPin: mocks.pin,
}));
vi.mock('@/lib/pharmacy/accounts/ap-credit-set-off', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/ap-credit-set-off')>(
    '@/lib/pharmacy/accounts/ap-credit-set-off'
  )),
  requestApCreditSetOff: mocks.requestSetOff,
  approveApCreditSetOff: mocks.approveSetOff,
  rejectApCreditSetOff: mocks.rejectSetOff,
  listApCreditSetOffs: mocks.listSetOffs,
  isSoleSetOffApprover: mocks.soleApprover,
  reverseApCreditSetOff: mocks.reverseSetOff,
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
      pharmacySupplierCredit: { findMany: mocks.creditFindMany },
      pharmacyApCreditSetOff: { groupBy: mocks.setOffGroupBy },
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
  mocks.setOffGroupBy.mockResolvedValue([]);
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

describe('pharmacyApInvoices router — payablesDrafts', () => {
  const draftsInput = { branchId: 'branch_1', asOf: '2026-11-15' };

  beforeEach(() => {
    mocks.creditFindMany.mockResolvedValue([]);
  });

  it('refuses without the finance licence, permission or an owner role', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().payablesDrafts(draftsInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.hasModule.mockReturnValue(true);
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action !== 'finance:read'
    );
    await expect(caller().payablesDrafts(draftsInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.aging).not.toHaveBeenCalled();
    expect(mocks.creditFindMany).not.toHaveBeenCalled();
  });

  it('refuses a branch outside the actor scope before any read', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(
      caller().payablesDrafts({ ...draftsInput, branchId: 'branch_x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.aging).not.toHaveBeenCalled();
    expect(mocks.creditFindMany).not.toHaveBeenCalled();
  });

  it('reads only the authorized organization and branch', async () => {
    const result = await caller().payablesDrafts(draftsInput);
    expect(result.scope).toEqual({ organizationId: 'org_1', branchId: 'branch_1' });
    expect(result.draftOnly).toBe(true);
    expect(mocks.aging).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      '2026-11-15',
      expect.any(Date),
      undefined,
      {}
    );
    expect(mocks.creditFindMany.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org_1',
      branchId: 'branch_1',
    });
  });

  it('cuts supplier credits off at the end of the as-of day', async () => {
    await caller().payablesDrafts(draftsInput);
    const where = mocks.creditFindMany.mock.calls[0]![0].where;
    expect(where.receivedAt.lt).toEqual(new Date('2026-11-16T00:00:00.000Z'));
  });

  it('rejects an invalid as-of day', async () => {
    await expect(
      caller().payablesDrafts({ ...draftsInput, asOf: '2026-02-30' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  describe('organization day boundary', () => {
    beforeEach(() => {
      // 01:00 on 16 Nov in Karachi, still 15 Nov in UTC.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-15T20:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const karachi = { organization: { id: 'org_1', timezone: 'Asia/Karachi' } };

    it("accepts the organization's today and cuts credits off on its clock", async () => {
      await caller(karachi as never).payablesDrafts({ ...draftsInput, asOf: '2026-11-16' });
      expect(mocks.aging).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        '2026-11-16',
        expect.any(Date),
        'Asia/Karachi',
        {}
      );
      const where = mocks.creditFindMany.mock.calls[0]![0].where;
      expect(where.receivedAt.lt).toEqual(new Date('2026-11-16T19:00:00.000Z'));
    });

    it('rejects a day that is still in the future for the organization', async () => {
      await expect(
        caller(karachi as never).payablesDrafts({ ...draftsInput, asOf: '2026-11-17' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('without a zone the UTC day still applies', async () => {
      await expect(
        caller().payablesDrafts({ ...draftsInput, asOf: '2026-11-16' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});

describe('pharmacyApInvoices router — payablesDrafts credit paging', () => {
  const draftsInput = { branchId: 'branch_1', asOf: '2026-11-15' };
  const credit = (n: number) => ({
    id: `cr_${n}`,
    reference: `CN-${n}`,
    amountMinor: 100,
    receivedAt: new Date('2026-11-01T00:00:00.000Z'),
    supplier: { name: 'Al-Shifa' },
    allocations: [],
    apSetOffs: n === 1 ? [{ amountMinor: 40 }] : [],
  });

  it('reads 5,000 credits per page and every page before reporting', async () => {
    const first = Array.from({ length: 5_000 }, (_, i) => credit(i + 1));
    mocks.creditFindMany.mockResolvedValueOnce(first).mockResolvedValueOnce([credit(5_001)]);
    const result = await caller().payablesDrafts(draftsInput);
    expect(mocks.creditFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.creditFindMany.mock.calls[0]![0]).toMatchObject({ take: 5_000 });
    expect(mocks.creditFindMany.mock.calls[0]![0].cursor).toBeUndefined();
    expect(mocks.creditFindMany.mock.calls[1]![0]).toMatchObject({
      take: 5_000,
      cursor: { id: 'cr_5000' },
      skip: 1,
    });
    expect(result.openCredits).toHaveLength(5_001);
    expect(result.creditsComplete).toBe(true);
    // Approved and pending set-offs already claim part of a credit.
    expect(result.openCredits[0]).toMatchObject({ creditId: 'cr_1', remainingMinor: 60 });
  });
});

describe('pharmacyApInvoices router — credit set-off', () => {
  const requestInput = {
    branchId: 'branch_1',
    invoiceId: 'inv_1',
    supplierCreditId: 'cr_1',
    requestKey: 'ap-set-off:0001',
    amountMinor: 2_500,
  };
  const approveInput = {
    branchId: 'branch_1',
    setOffId: 'so_1',
    decisionKey: 'ap-set-off-ok:0001',
    pin: '2468',
  };
  const pending = {
    id: 'so_1',
    status: 'PENDING',
    invoiceId: 'inv_1',
    supplierCreditId: 'cr_1',
    amountMinor: 2_500,
    requestedByUserId: 'clerk_1',
  };
  const approved = {
    ...pending,
    status: 'APPROVED',
    decidedByUserId: 'owner_1',
    decidedAt: new Date('2026-11-18T10:00:00.000Z'),
    approvalPolicy: 'PHARMACY_AP_SET_OFF_MANAGER_PIN',
    journalEntryId: 'entry_9',
  };

  beforeEach(() => {
    mocks.mayManage.mockResolvedValue(true);
    mocks.pin.mockResolvedValue({ verified: true });
    mocks.requestSetOff.mockResolvedValue({ setOff: pending, replayed: false });
    mocks.approveSetOff.mockResolvedValue({ setOff: approved, replayed: false });
    mocks.rejectSetOff.mockResolvedValue({
      setOff: { ...pending, status: 'REJECTED' },
      replayed: false,
    });
    mocks.listSetOffs.mockResolvedValue([]);
  });

  it('is mounted on the root router', async () => {
    const { appRouter } = await import('./_app');
    expect(Object.keys(appRouter._def.procedures)).toEqual(
      expect.arrayContaining([
        'pharmacyApInvoices.creditSetOffs',
        'pharmacyApInvoices.requestCreditSetOff',
        'pharmacyApInvoices.approveCreditSetOff',
        'pharmacyApInvoices.rejectCreditSetOff',
      ])
    );
  }, 60_000);

  it('records a request in one audited transaction without posting money', async () => {
    await expect(caller().requestCreditSetOff(requestInput)).resolves.toMatchObject({
      status: 'PENDING',
    });
    expect(mocks.requestSetOff).toHaveBeenCalledWith(TX, scope, requestInput);
    expect(mocks.pin).not.toHaveBeenCalled();
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacyApInvoices.requestCreditSetOff',
        targetType: 'PharmacyApCreditSetOff',
      }),
      TX
    );
  });

  it('refuses every set-off command without Pharmacy Finance access', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().requestCreditSetOff(requestInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().approveCreditSetOff(approveInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().creditSetOffs({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.requestSetOff).not.toHaveBeenCalled();
    expect(mocks.approveSetOff).not.toHaveBeenCalled();
    expect(mocks.listSetOffs).not.toHaveBeenCalled();
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it('refuses approval or rejection by someone who is not a manager or owner', async () => {
    mocks.mayManage.mockResolvedValue(false);
    await expect(caller().approveCreditSetOff(approveInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a manager or owner can approve, reject or reverse a set-off.',
    });
    await expect(
      caller().rejectCreditSetOff({
        branchId: 'branch_1',
        setOffId: 'so_1',
        decisionKey: 'ap-set-off-no:0001',
        reason: 'Wrong bill',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.pin).not.toHaveBeenCalled();
    expect(mocks.approveSetOff).not.toHaveBeenCalled();
    expect(mocks.rejectSetOff).not.toHaveBeenCalled();
  });

  it('refuses approval when the PIN is refused, before any money moves', async () => {
    mocks.pin.mockResolvedValue({ blocked: 'nope' });
    await expect(caller().approveCreditSetOff(approveInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Set-off not approved. Enter your manager or owner PIN.',
    });
    expect(mocks.pin).toHaveBeenCalledWith({
      organizationId: 'org_1',
      actorId: 'owner_1',
      pin: '2468',
      action: 'pharmacyApInvoices.approveCreditSetOff',
      policy: 'PHARMACY_AP_SET_OFF_MANAGER_PIN',
      errorCode: 'AP_SET_OFF_PIN_REFUSED',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.approveSetOff).not.toHaveBeenCalled();
  });

  it('approves with a verified PIN and audits who requested and who approved', async () => {
    mocks.soleApprover.mockResolvedValue(false);
    await expect(caller().approveCreditSetOff(approveInput)).resolves.toMatchObject({
      status: 'APPROVED',
    });
    expect(mocks.approveSetOff).toHaveBeenCalledWith(
      TX,
      scope,
      approveInput,
      expect.objectContaining({ soleApprover: expect.any(Function) })
    );
    const options = mocks.approveSetOff.mock.calls[0]![3];
    await options.soleApprover();
    expect(mocks.soleApprover).toHaveBeenCalledWith(TX, 'org_1', 'owner_1');
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacyApInvoices.approveCreditSetOff',
        operation: 'EXECUTE',
        result: expect.objectContaining({ status: 'APPROVED', entryId: 'entry_9' }),
        metadata: expect.objectContaining({
          policy: 'PHARMACY_AP_SET_OFF_MANAGER_PIN',
          approverId: 'owner_1',
          initiatedById: 'clerk_1',
          pinVerified: true,
          selfApproved: false,
        }),
      }),
      TX
    );
  });

  it('maps a refused self-approval to FORBIDDEN', async () => {
    mocks.approveSetOff.mockRejectedValue(new PharmacyApInvoiceError('SELF_APPROVAL'));
    await expect(caller().approveCreditSetOff(approveInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Another manager or owner must approve a set-off you requested.',
    });
  });

  it.each(['SET_OFF_EXCEEDS_CREDIT', 'SET_OFF_EXCEEDS_BILL', 'ALREADY_DECIDED'] as const)(
    'maps %s to CONFLICT',
    async (reason) => {
      mocks.approveSetOff.mockRejectedValue(new PharmacyApInvoiceError(reason));
      await expect(caller().approveCreditSetOff(approveInput)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: reason,
      });
    }
  );

  it('rejects a PIN that is not 4 to 8 digits at the wire', async () => {
    await expect(
      caller().approveCreditSetOff({ ...approveInput, pin: '12a4' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.pin).not.toHaveBeenCalled();
  });
});

describe('pharmacyApInvoices router — set-off suggestion capacity', () => {
  const draftsInput = { branchId: 'branch_1', asOf: '2026-11-15' };
  const cutoff = new Date('2026-11-16T00:00:00.000Z');
  const bill = (id: string, outstandingMinor: number) => ({
    invoiceId: id,
    reference: `AP-${id}`,
    payeeName: 'Al-Shifa',
    supplierInvoiceRef: id,
    invoiceDate: '2026-10-01',
    dueDate: '2026-10-31',
    currency: 'PKR',
    amountMinor: outstandingMinor,
    paidMinor: 0,
    setOffMinor: 0,
    outstandingMinor,
    daysPastDue: 15,
    bucket: 'DAYS_1_30',
  });

  it('holds credit reserved at the cutoff, even when the request was decided later', async () => {
    mocks.creditFindMany.mockResolvedValue([]);
    await caller().payablesDrafts(draftsInput);
    expect(mocks.creditFindMany.mock.calls[0]![0].select.apSetOffs.where).toEqual({
      requestedAt: { lt: cutoff },
      NOT: [
        { status: 'REJECTED', decidedAt: { lt: cutoff } },
        { status: 'REVERSED', reversedAt: { lt: cutoff } },
      ],
    });
  });

  it('never suggests bill capacity already reserved by an undecided request', async () => {
    mocks.aging.mockResolvedValue({
      asOf: '2026-11-15',
      complete: true,
      scannedInvoices: 2,
      rows: [bill('inv_1', 1_000), bill('inv_2', 1_000)],
      totals: [],
    });
    mocks.creditFindMany.mockResolvedValue([
      {
        id: 'cr_1',
        reference: 'CN-1',
        amountMinor: 1_500,
        receivedAt: new Date('2026-11-01T00:00:00.000Z'),
        supplier: { name: 'Al-Shifa' },
        allocations: [],
        apSetOffs: [],
      },
    ]);
    // inv_1 is fully reserved by a pending request; inv_2 has 400 reserved.
    mocks.setOffGroupBy.mockResolvedValue([
      { invoiceId: 'inv_1', _sum: { amountMinor: 1_000 } },
      { invoiceId: 'inv_2', _sum: { amountMinor: 400 } },
    ]);
    const result = await caller().payablesDrafts(draftsInput);
    expect(mocks.setOffGroupBy.mock.calls[0]![0].where).toEqual({
      organizationId: 'org_1',
      branchId: 'branch_1',
      requestedAt: { lt: cutoff },
      OR: [{ status: 'PENDING' }, { decidedAt: { gte: cutoff } }],
    });
    expect(result.setOffDraft.lines).toEqual([
      expect.objectContaining({ invoiceId: 'inv_2', setOffMinor: 600 }),
    ]);
    expect(result.setOffDraft.unmatchedCreditMinor).toBe(900);
    // The reminders still use the unchanged aging.
    expect(result.reminders[0]!.overdueMinor).toBe(2_000);
  });
});

describe('pharmacyApInvoices router — credit set-off reversal', () => {
  const reverseInput = {
    branchId: 'branch_1',
    setOffId: 'so_1',
    commandKey: 'ap-set-off-rev:0001',
    reason: 'Wrong bill',
    pin: '2468',
  };
  const reversed = {
    id: 'so_1',
    status: 'REVERSED',
    invoiceId: 'inv_1',
    supplierCreditId: 'cr_1',
    amountMinor: 2_500,
    requestedByUserId: 'clerk_1',
    reversedByUserId: 'owner_1',
    reversedAt: new Date('2026-11-18T11:00:00.000Z'),
    reversalPolicy: 'PHARMACY_AP_SET_OFF_REVERSAL_MANAGER_PIN',
    reversalEntryId: 'entry_rev',
  };

  beforeEach(() => {
    mocks.mayManage.mockResolvedValue(true);
    mocks.pin.mockResolvedValue({ verified: true });
    mocks.reverseSetOff.mockResolvedValue({ setOff: reversed, replayed: false });
  });

  it('is mounted on the root router', async () => {
    const { appRouter } = await import('./_app');
    expect(Object.keys(appRouter._def.procedures)).toContain(
      'pharmacyApInvoices.reverseCreditSetOff'
    );
  }, 60_000);

  it('refuses a non-manager and a refused PIN before any money moves', async () => {
    mocks.mayManage.mockResolvedValue(false);
    await expect(caller().reverseCreditSetOff(reverseInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.pin).not.toHaveBeenCalled();
    mocks.mayManage.mockResolvedValue(true);
    mocks.pin.mockResolvedValue({ blocked: 'nope' });
    await expect(caller().reverseCreditSetOff(reverseInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Set-off not reversed. Enter your manager or owner PIN.',
    });
    expect(mocks.pin).toHaveBeenCalledWith({
      organizationId: 'org_1',
      actorId: 'owner_1',
      pin: '2468',
      action: 'pharmacyApInvoices.reverseCreditSetOff',
      policy: 'PHARMACY_AP_SET_OFF_REVERSAL_MANAGER_PIN',
      errorCode: 'AP_SET_OFF_REVERSAL_PIN_REFUSED',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.reverseSetOff).not.toHaveBeenCalled();
  });

  it('reverses in one audited transaction with the solo check wired in', async () => {
    mocks.soleApprover.mockResolvedValue(false);
    await expect(caller().reverseCreditSetOff(reverseInput)).resolves.toMatchObject({
      status: 'REVERSED',
    });
    expect(mocks.reverseSetOff).toHaveBeenCalledWith(
      TX,
      scope,
      reverseInput,
      expect.objectContaining({ soleApprover: expect.any(Function) })
    );
    await mocks.reverseSetOff.mock.calls[0]![3].soleApprover();
    expect(mocks.soleApprover).toHaveBeenCalledWith(TX, 'org_1', 'owner_1');
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacyApInvoices.reverseCreditSetOff',
        operation: 'EXECUTE',
        result: expect.objectContaining({ status: 'REVERSED', reversalEntryId: 'entry_rev' }),
        metadata: expect.objectContaining({
          policy: 'PHARMACY_AP_SET_OFF_REVERSAL_MANAGER_PIN',
          reversedById: 'owner_1',
          initiatedById: 'clerk_1',
          pinVerified: true,
          selfApproved: false,
        }),
      }),
      TX
    );
  });

  it.each([
    ['ALREADY_REVERSED', 'CONFLICT'],
    ['PERIOD_CLOSED', 'BAD_REQUEST'],
    ['SELF_APPROVAL', 'FORBIDDEN'],
  ] as const)('maps %s to %s', async (reason, code) => {
    mocks.reverseSetOff.mockRejectedValue(new PharmacyApInvoiceError(reason));
    await expect(caller().reverseCreditSetOff(reverseInput)).rejects.toMatchObject({ code });
  });
});

describe('pharmacyApInvoices router — aging payee filter', () => {
  it('passes the one-payee filter to both the aging read and the drafts read', async () => {
    mocks.creditFindMany.mockResolvedValue([]);
    await caller().aging({ branchId: 'branch_1', asOf: '2026-11-15', payeeFilter: 'K-Electric' });
    await caller().payablesDrafts({
      branchId: 'branch_1',
      asOf: '2026-11-15',
      payeeFilter: 'K-Electric',
    });
    for (const call of mocks.aging.mock.calls) {
      expect(call[5]).toEqual({ payeeName: 'K-Electric' });
    }
    expect(mocks.aging).toHaveBeenCalledTimes(2);
  });
});
