/**
 * M5-L4 router — capability gating/wiring, strict inputs, the C12 payments read
 * model (tenders, refunds, the payment event trail, per-date tender-type totals) and
 * money-as-string serialization. Runs the REAL router against a hand-rolled in-memory
 * db; the ABAC decision, entitlement check and audit writer are mocked (platform
 * middleware). The exact Decimal fold in `getTenderTypeTotals` runs for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  rotate: vi.fn(),
  tenderFindMany: vi.fn(),
  refundFindMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  reconciliationFindMany: vi.fn(async () => []),
  terminalConfigFindMany: vi.fn(async () => []),
  requireBranchScope: vi.fn<(ctx: unknown, branchId: string) => Promise<void>>(
    async () => undefined
  ),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/restaurant-branch-scope', () => ({
  requireRestaurantBranchScope: mocks.requireBranchScope,
}));

import { restaurantPaymentsRouter } from './restaurant-payments';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  $executeRaw: mocks.rotate,
  restaurantTender: { findMany: mocks.tenderFindMany },
  restaurantRefund: { findMany: mocks.refundFindMany },
  restaurantPayment: { findUnique: mocks.paymentFindUnique },
  restaurantTerminalReconciliation: { findMany: mocks.reconciliationFindMany },
  restaurantTerminalProviderConfig: { findMany: mocks.terminalConfigFindMany },
} as unknown as ScopedDb;

function caller(role = 'EMPLOYEE') {
  return restaurantPaymentsRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_gm',
        role,
        organizationId: 'org-test',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org-test' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.tenderFindMany.mockResolvedValue([]);
  mocks.refundFindMany.mockResolvedValue([]);
});

describe('tender reads (C12)', () => {
  it('lists tenders with string money, cash fields, and a cursor', async () => {
    const row = (id: string) => ({
      id,
      billId: 'bill_1',
      type: 'CASH',
      amount: D('12.50'),
      tipAmount: D('0.00'),
      cashReceived: D('20.00'),
      changeGiven: D('7.50'),
      drawerSessionId: 'drawer_1',
      paymentId: null,
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      staffProfileId: 'op_1',
      deviceId: 'dev_1',
      createdAt: new Date(),
    });
    mocks.tenderFindMany.mockResolvedValue([row('t1'), row('t2'), row('t3')]);
    const result = await caller().listTenders({ branchId: 'b1', limit: 2 });
    expect(result.tenders).toHaveLength(2);
    expect(result.tenders[0].amount).toBe('12.5');
    expect(result.tenders[0].changeGiven).toBe('7.5');
    expect(result.tenders[0].businessDate).toBe('2026-08-19');
    expect(result.nextCursor).toBe('t2');
  });

  it('leaves card tenders cashReceived/changeGiven null', async () => {
    mocks.tenderFindMany.mockResolvedValue([
      {
        id: 't1',
        billId: 'bill_1',
        type: 'CARD',
        amount: D('30.00'),
        tipAmount: D('4.00'),
        cashReceived: null,
        changeGiven: null,
        drawerSessionId: null,
        paymentId: 'pay_1',
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        staffProfileId: 'op_1',
        deviceId: 'dev_1',
        createdAt: new Date(),
      },
    ]);
    const result = await caller().listTenders({ branchId: 'b1' });
    expect(result.tenders[0].cashReceived).toBeNull();
    expect(result.tenders[0].changeGiven).toBeNull();
    expect(result.tenders[0].tipAmount).toBe('4');
    expect(result.tenders[0].paymentId).toBe('pay_1');
    expect(result.nextCursor).toBeNull();
  });

  it('passes branch/businessDate/billId/type filters to the query', async () => {
    await caller().listTenders({
      branchId: 'b1',
      businessDate: '2026-08-19',
      billId: 'bill_1',
      type: 'CARD',
    });
    const where = mocks.tenderFindMany.mock.calls[0][0].where;
    expect(where.bill).toEqual({ branchId: 'b1' });
    expect(where.billId).toBe('bill_1');
    expect(where.type).toBe('CARD');
    expect(where.businessDate).toBeInstanceOf(Date);
  });
});

describe('refund reads (C12)', () => {
  it('lists refunds with string money and a cursor', async () => {
    const row = (id: string) => ({
      id,
      originalTenderId: 'tender_1',
      billId: 'bill_1',
      kind: 'REFUND',
      amount: D('5.00'),
      tipRefundAmount: D('0.00'),
      serviceChargeRefundAmount: D('1.25'),
      taxRefundAmount: D('0.75'),
      businessDate: new Date('2026-08-20T00:00:00.000Z'),
      reason: 'return',
      cardMachineRefundReference: 'BANK-REF-42',
      coAuthorizationId: 'coauth_1',
      drawerSessionId: null,
      paymentId: 'pay_1',
      staffProfileId: 'op_1',
      deviceId: 'dev_1',
      createdAt: new Date(),
    });
    mocks.refundFindMany.mockResolvedValue([row('r1'), row('r2')]);
    const result = await caller().listRefunds({ branchId: 'b1', limit: 1 });
    expect(result.refunds).toHaveLength(1);
    expect(result.refunds[0].amount).toBe('5');
    expect(result.refunds[0].serviceChargeRefundAmount).toBe('1.25');
    expect(result.refunds[0].taxRefundAmount).toBe('0.75');
    expect(result.refunds[0].kind).toBe('REFUND');
    expect(result.refunds[0].cardMachineRefundReference).toBe('BANK-REF-42');
    expect(result.refunds[0].businessDate).toBe('2026-08-20');
    expect(result.nextCursor).toBe('r1');
  });
});

describe('getPayment (full event trail, C12)', () => {
  it('returns the payment with its ordered events, tenders and refunds as strings', async () => {
    mocks.paymentFindUnique.mockResolvedValue({
      id: 'pay_1',
      billId: 'bill_1',
      bill: { branchId: 'b1' },
      provider: 'MOCK',
      capability: 'SALE',
      status: 'REFUNDED',
      amount: D('12.50'),
      tipAmount: D('2.00'),
      providerRef: 'mock_sale_abc',
      staffProfileId: 'op_1',
      deviceId: 'dev_1',
      createdAt: new Date(),
      events: [
        {
          id: 'e1',
          capability: 'SALE',
          eventType: 'SALE_APPROVED',
          amount: D('12.50'),
          providerRef: 'mock_sale_abc',
          payload: { provider: 'MOCK' },
          createdAt: new Date(),
        },
        {
          id: 'e2',
          capability: 'REFUND',
          eventType: 'REFUND_APPROVED',
          amount: D('12.50'),
          providerRef: 'mock_refund_def',
          payload: { provider: 'MOCK' },
          createdAt: new Date(),
        },
      ],
      tenders: [
        {
          id: 't1',
          type: 'CARD',
          amount: D('12.50'),
          tipAmount: D('2.00'),
          businessDate: new Date('2026-08-19T00:00:00.000Z'),
          createdAt: new Date(),
        },
      ],
      refunds: [
        {
          id: 'r1',
          kind: 'REFUND',
          amount: D('12.50'),
          tipRefundAmount: D('0.00'),
          serviceChargeRefundAmount: D('1.25'),
          taxRefundAmount: D('0.75'),
          businessDate: new Date('2026-08-19T00:00:00.000Z'),
          createdAt: new Date(),
        },
      ],
    });
    const result = await caller().getPayment({ paymentId: 'pay_1' });
    expect(result.status).toBe('REFUNDED');
    expect(result.amount).toBe('12.5');
    expect(result.tipAmount).toBe('2');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ eventType: 'SALE_APPROVED', amount: '12.5' });
    expect(result.events[1]).toMatchObject({ eventType: 'REFUND_APPROVED' });
    expect(result.tenders[0]).toMatchObject({ type: 'CARD', amount: '12.5' });
    expect(result.refunds[0]).toMatchObject({ kind: 'REFUND', amount: '12.5' });
    expect(result.refunds[0]).toMatchObject({
      tipRefundAmount: '0',
      serviceChargeRefundAmount: '1.25',
      taxRefundAmount: '0.75',
    });
    expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), 'b1');
  });

  it('throws NOT_FOUND for a missing payment', async () => {
    mocks.paymentFindUnique.mockResolvedValue(null);
    await expect(caller().getPayment({ paymentId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('getTenderTypeTotals (per-date summary, C12)', () => {
  it('folds each tender type exactly and reports a deterministic CASH/CARD/OTHER order + totals', async () => {
    mocks.tenderFindMany.mockResolvedValue([
      { type: 'CASH', amount: D('12.50'), tipAmount: D('0.00') },
      { type: 'CASH', amount: D('7.25'), tipAmount: D('0.00') },
      { type: 'CARD', amount: D('30.00'), tipAmount: D('4.00') },
      { type: 'CARD', amount: D('0.05'), tipAmount: D('0.01') },
    ]);
    const result = await caller().getTenderTypeTotals({
      branchId: 'b1',
      businessDate: '2026-08-19',
    });
    expect(result.tenderTypes.map((t) => t.tenderType)).toEqual(['CASH', 'CARD', 'OTHER']);
    expect(result.tenderTypes[0]).toMatchObject({ tenderType: 'CASH', amount: '19.75', count: 2 });
    expect(result.tenderTypes[1]).toMatchObject({
      tenderType: 'CARD',
      amount: '30.05',
      tipAmount: '4.01',
      count: 2,
    });
    expect(result.tenderTypes[2]).toMatchObject({ tenderType: 'OTHER', amount: '0', count: 0 });
    expect(result.totals).toMatchObject({ amount: '49.8', tipAmount: '4.01', count: 4 });
  });
});

describe('capability gating + strict inputs', () => {
  it('guards every list and summary by its exact branch', async () => {
    await caller().listTenders({ branchId: 'b1' });
    await caller().listRefunds({ branchId: 'b2' });
    await caller().listTerminalReconciliations({ branchId: 'b3' });
    await caller().getTenderTypeTotals({ branchId: 'b4', businessDate: '2026-08-19' });
    await caller().getTerminalConfig({ branchId: 'b5' });
    expect(mocks.can.mock.calls.some((c) => c[1] === 'money:read')).toBe(true);
    expect(mocks.requireBranchScope.mock.calls.map((call) => call[1])).toEqual([
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
    ]);
  });

  it('denies a direct payment ID before fetching event detail', async () => {
    mocks.paymentFindUnique.mockResolvedValue({ bill: { branchId: 'blocked' } });
    mocks.requireBranchScope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller().getPayment({ paymentId: 'payment-blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.paymentFindUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown input fields (strict)', async () => {
    await expect(
      // @ts-expect-error — surplus field must be rejected, never stripped
      caller().listTenders({ branchId: 'b1', surplus: true })
    ).rejects.toBeDefined();
  });
});

describe('terminal webhook key administration', () => {
  const input = { branchId: 'branch-1', configId: 'cfg-1' };
  it('requires both the configuration capability and a business administrator', async () => {
    await expect(caller().rotateTerminalWebhookSecret(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.can.mockResolvedValue(false);
    await expect(caller('ADMIN').rotateTerminalWebhookSecret(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.rotate).not.toHaveBeenCalled();
  });
  it('returns a fresh secret once per rotation and passes only ciphertext to the scoped write', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'test-only-key');
    try {
      mocks.requireBranchScope.mockResolvedValue(undefined);
      mocks.rotate.mockResolvedValue(1);
      const first = await caller('ADMIN').rotateTerminalWebhookSecret(input);
      const second = await caller('ADMIN').rotateTerminalWebhookSecret(input);
      expect(second.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.secret).not.toBe(first.secret);
      expect(mocks.requireBranchScope).toHaveBeenCalledWith(expect.anything(), input.branchId);
      const { decryptSecret } = await import('@/lib/secret-crypto');
      expect(decryptSecret(mocks.rotate.mock.calls[1]![1])).toBe(second.secret);
      expect(mocks.rotate.mock.calls[1]!.slice(2)).toEqual([
        'org-test',
        input.branchId,
        input.configId,
      ]);
      await caller('ADMIN').getTerminalConfig({ branchId: input.branchId });
      expect(mocks.terminalConfigFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            branchId: true,
            source: true,
            externalTerminalId: true,
            deviceId: true,
            mode: true,
            updatedAt: true,
          },
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
