import { readFileSync } from 'node:fs';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Source/pure checks only. Transaction and RLS evidence belongs to the PostgreSQL suite.
vi.mock('./daily-close', () => ({ assertMoneyDayOpen: vi.fn() }));
// appendMovement re-checks the drawer's own financial day through the shared guard.
vi.mock('./money-day', () => ({ assertMoneyDayOpen: vi.fn(), lockMoneyDay: vi.fn() }));
vi.mock('./staff-branch-authorization', () => ({
  assertActorEligibleForBranch: vi.fn(),
  assertAuthorizedBranch: vi.fn(),
}));
import {
  assertCateringEvidenceLimit,
  summarizeCateringMoney,
  validateCateringMoneyInput,
  type CateringEvidence,
  type CateringMoneyInput,
} from './catering-money';
import { foldExpectedCash } from './drawer-sessions';
import { assertMoneyDayOpen } from './daily-close';
import { assertMoneyDayOpen as assertDrawerMoneyDayOpen } from './money-day';

const input: CateringMoneyInput = {
  cateringOrderId: 'order',
  quoteRevisionId: 'quote',
  kind: 'DEPOSIT',
  amount: '28.00',
  currency: 'PKR',
  source: 'CASH',
  drawerSessionId: 'drawer',
  idempotencyKey: 'key',
};
const receipt: CateringEvidence = {
  id: 'receipt',
  quoteRevisionId: 'quote',
  kind: 'DEPOSIT',
  amount: '28.00',
  currency: 'PKR',
  source: 'CASH',
  originalEvidenceId: null,
  drawerMovementId: 'in',
};
const refund: CateringEvidence = {
  ...receipt,
  id: 'refund',
  kind: 'REFUND',
  amount: '8.00',
  originalEvidenceId: receipt.id,
  drawerMovementId: 'out',
};

describe('catering evidence validation and accounting (not runtime DB proof)', () => {
  it.each(['0', '-1', '0.001', '1e2', 'NaN', 'Infinity', '10000000000', ' 1', '1.'])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => validateCateringMoneyInput({ ...input, amount })).toThrow('INVALID_AMOUNT');
    }
  );
  it('normalizes exact Decimal money without treating planned deposit as paid', () => {
    expect(validateCateringMoneyInput({ ...input, amount: '28' }).toFixed(2)).toBe('28.00');
    expect(summarizeCateringMoney('100.00', '50.00', [], 'PKR')).toMatchObject({
      plannedDepositAmount: '50.00',
      netPaid: '0.00',
      amountDue: '100.00',
      refundableBalance: '0.00',
    });
    expect(summarizeCateringMoney(null, '50.00', [], 'PKR').amountDue).toBeNull();
  });
  it('requires explicit noncash source/reference and rejects mixed cash metadata', () => {
    expect(() =>
      validateCateringMoneyInput({
        ...input,
        source: 'OPERATOR_ATTESTED',
        drawerSessionId: undefined,
      })
    ).toThrow('INVALID_SOURCE');
    expect(() =>
      validateCateringMoneyInput({ ...input, externalEvidenceReference: 'ref' })
    ).toThrow('UNEXPECTED_EXTERNAL');
    expect(
      validateCateringMoneyInput({
        ...input,
        source: 'OPERATOR_ATTESTED',
        drawerSessionId: undefined,
        externalEvidenceSource: 'Bank slip',
        externalEvidenceReference: 'ref',
      }).toFixed(2)
    ).toBe('28.00');
  });
  it('caps receipts at current approved quote less net paid', () => {
    expect(() => assertCateringEvidenceLimit(input, '40', [receipt])).toThrow('OVERPAYMENT');
    expect(() => assertCateringEvidenceLimit(input, '48', [receipt, refund])).not.toThrow();
  });
  it('caps refund at original net refundable receipt; rejects unrelated or wrong currency/source', () => {
    const command: CateringMoneyInput = {
      ...input,
      kind: 'REFUND',
      originalEvidenceId: receipt.id,
      amount: '20',
    };
    expect(() => assertCateringEvidenceLimit(command, '100', [receipt, refund])).not.toThrow();
    expect(() =>
      assertCateringEvidenceLimit({ ...command, amount: '20.01' }, '100', [receipt, refund])
    ).toThrow('OVER_REFUND');
    expect(() =>
      assertCateringEvidenceLimit({ ...command, originalEvidenceId: refund.id }, '100', [
        receipt,
        refund,
      ])
    ).toThrow('ORIGINAL_MISMATCH');
    expect(() =>
      assertCateringEvidenceLimit(command, '100', [{ ...receipt, currency: 'USD' }])
    ).toThrow('CURRENCY_MISMATCH');
    expect(() =>
      assertCateringEvidenceLimit(command, '100', [{ ...receipt, source: 'OPERATOR_ATTESTED' }])
    ).toThrow('ORIGINAL_MISMATCH');
  });
  it('summarizes separate receipts/refunds and folds cash adjustments exactly once', () => {
    expect(summarizeCateringMoney('100.00', '50.00', [receipt, refund], 'PKR')).toMatchObject({
      recordedReceipts: '28.00',
      recordedRefunds: '8.00',
      netPaid: '20.00',
      refundableBalance: '20.00',
      amountDue: '80.00',
    });
    expect(
      foldExpectedCash([
        { kind: 'OPENING_FLOAT', amount: '100' },
        { kind: 'PAID_IN', amount: '28' },
        { kind: 'PAID_OUT', amount: '8' },
      ]).toFixed(2)
    ).toBe('120.00');
  });
  it('has no settlement/provider/stock writer and uses the common order lock', () => {
    const source = readFileSync(new URL('./catering-money.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'pg_advisory_xact_lock(hashtextextended(${input.cateringOrderId}, 0))'
    );
    expect(source).not.toMatch(
      /tx\.(restaurantTender|restaurantPayment|restaurantBill|restaurantStockMovement)|postStockMovements|applyTender|\.\$transaction\(/
    );
    expect(source).toContain("input.kind === 'REFUND' ? 'PAID_OUT' : 'PAID_IN'");
    const close = readFileSync(new URL('./daily-close.ts', import.meta.url), 'utf8');
    expect(close).not.toContain('restaurant_catering_money_evidence');
  });
});

// Model-delegate unit harness. These checks exercise service ordering/replay/guards,
// but intentionally make no PostgreSQL atomicity or RLS claim.
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordCateringMoneyEvidence, type CateringMoneyScope } from './catering-money';

const scope: CateringMoneyScope = {
  organizationId: 'org',
  branchId: 'branch',
  staffProfileId: 'staff',
  deviceId: 'device',
  authorization: {
    actorStaffProfileId: 'staff',
    actorBranchIds: ['branch'],
    organizationWide: false,
    branchIds: ['branch'],
  },
};
const DRAWER_DAY = new Date('2026-08-19T00:00:00.000Z');
function fixture() {
  const keys = new Map<string, Record<string, unknown>>();
  const evidence: CateringEvidence[] = [];
  const calls: string[] = [];
  const quote = {
    id: 'quote',
    revision: 0,
    orderRevision: 0,
    approvedQuoteRevisionId: 'quote',
    currency: 'PKR',
    quotedTotal: '100',
    approvalId: 'approved',
    contentHash: 'hash',
  };
  const order = { id: 'order', status: 'DRAFT' };
  const grants = ['catering:manage', 'cash:adjust', 'payments:refund'].map((capability) => ({
    capability,
    effect: 'ALLOW',
  }));
  const tx = {
    restaurantStaffProfile: { findFirst: vi.fn(async () => ({ id: 'staff' })) },
    restaurantRegisteredDevice: {
      findFirst: vi.fn(async () => ({ branch: { timezone: 'UTC', businessDayCutoff: '00:00' } })),
    },
    restaurantStaffJobRole: { findMany: vi.fn(async () => []) },
    restaurantStaffCapabilityGrant: { findMany: vi.fn(async () => grants) },
    restaurantCateringOrder: { findFirst: vi.fn(async () => order) },
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn(
        async ({ where }: { where: { deviceId_key: { key: string } } }) =>
          keys.get(where.deviceId_key.key) ?? null
      ),
      create: vi.fn(async ({ data }: { data: { key: string } }) => {
        keys.set(data.key, { ...data, resultRef: null, resultPayload: null, completedAt: null });
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { key: string }; data: Record<string, unknown> }) => {
          keys.set(where.key, { ...keys.get(where.key), ...data });
          return { count: 1 };
        }
      ),
    },
    restaurantDrawerSession: {
      findFirst: vi.fn(async () => ({ id: 'drawer' })),
      findUnique: vi.fn(async () => ({
        id: 'drawer',
        status: 'OPEN',
        branchId: 'branch',
        businessDate: DRAWER_DAY,
      })),
    },
    restaurantDrawerMovement: {
      create: vi.fn(async () => {
        calls.push('movement');
        return { id: 'movement' };
      }),
    },
    auditLog: {
      create: vi.fn(async () => {
        calls.push('audit');
      }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      calls.push(sql.includes('INSERT') ? 'evidence' : 'lock');
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('quote_revisions')) {
        calls.push('quote');
        return [quote];
      }
      if (sql.includes('money_evidence')) {
        calls.push('cap');
        return evidence;
      }
      return [];
    }),
  };
  return { tx, db: tx as unknown as ScopedDb, quote, order, evidence, grants, calls };
}

describe('catering evidence service (unit delegates, not DB proof)', () => {
  it('locks before quote/cap reads; writes movement, evidence, audit, then completed replay', async () => {
    const f = fixture();
    const result = await recordCateringMoneyEvidence(f.db, scope, input);
    expect(f.calls).toEqual(['lock', 'quote', 'cap', 'movement', 'evidence', 'audit']);
    expect(result).toMatchObject({ ledgerReference: 'movement', replayed: false });
    expect(assertDrawerMoneyDayOpen).toHaveBeenCalledWith(f.db, 'branch', DRAWER_DAY);
    const before = f.tx.restaurantDrawerMovement.create.mock.calls.length;
    expect(await recordCateringMoneyEvidence(f.db, scope, { ...input, amount: '28' })).toEqual({
      ...result,
      replayed: true,
    });
    expect(f.tx.restaurantDrawerMovement.create).toHaveBeenCalledTimes(before);
    await expect(
      recordCateringMoneyEvidence(f.db, scope, { ...input, amount: '29' })
    ).rejects.toThrow('different canonical money payload');
  });
  it.each(['approvedQuoteRevisionId', 'approvalId', 'contentHash'])(
    'denies missing quote %s',
    async (field) => {
      const f = fixture();
      Object.assign(f.quote, { [field]: null });
      await expect(recordCateringMoneyEvidence(f.db, scope, input)).rejects.toThrow(
        'STALE_OR_UNAPPROVED_QUOTE'
      );
      expect(f.tx.restaurantDrawerMovement.create).not.toHaveBeenCalled();
    }
  );
  it('denies stale quote revision, cross-currency and missing order', async () => {
    const stale = fixture();
    stale.quote.orderRevision = 1;
    await expect(recordCateringMoneyEvidence(stale.db, scope, input)).rejects.toThrow(
      'STALE_OR_UNAPPROVED_QUOTE'
    );
    const currency = fixture();
    currency.quote.currency = 'USD';
    await expect(recordCateringMoneyEvidence(currency.db, scope, input)).rejects.toThrow(
      'CURRENCY_MISMATCH'
    );
    const missing = fixture();
    missing.tx.restaurantCateringOrder.findFirst.mockResolvedValueOnce(null as never);
    await expect(recordCateringMoneyEvidence(missing.db, scope, input)).rejects.toThrow(
      'ORDER_NOT_FOUND'
    );
    expect(missing.tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
  });
  it('denies actor mismatch, missing device and denied capability before idempotency writes', async () => {
    const f = fixture();
    await expect(
      recordCateringMoneyEvidence(f.db, { ...scope, staffProfileId: 'other' }, input)
    ).rejects.toThrow('ACTOR_MISMATCH');
    f.tx.restaurantRegisteredDevice.findFirst.mockResolvedValueOnce(null as never);
    await expect(recordCateringMoneyEvidence(f.db, scope, input)).rejects.toThrow(
      'ACTOR_OR_DEVICE_DENIED'
    );
    f.grants.push({ capability: 'cash:adjust', effect: 'DENY' });
    await expect(recordCateringMoneyEvidence(f.db, scope, input)).rejects.toThrow(
      'CAPABILITY_DENIED'
    );
    expect(f.tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
  });
  it('propagates late failure without completing the replay key', async () => {
    const f = fixture();
    f.tx.auditLog.create.mockRejectedValueOnce(new Error('audit failed'));
    await expect(recordCateringMoneyEvidence(f.db, scope, input)).rejects.toThrow('audit failed');
    expect(f.tx.restaurantMoneyIdempotencyKey.updateMany).not.toHaveBeenCalled();
  });
  it('rejects closed business day and closed drawer before evidence or audit completion', async () => {
    const day = fixture();
    vi.mocked(assertMoneyDayOpen).mockRejectedValueOnce(new Error('day closed'));
    await expect(recordCateringMoneyEvidence(day.db, scope, input)).rejects.toThrow('day closed');
    expect(day.tx.restaurantDrawerMovement.create).not.toHaveBeenCalled();
    const drawer = fixture();
    drawer.tx.restaurantDrawerSession.findUnique.mockResolvedValue({
      id: 'drawer',
      status: 'CLOSED',
      branchId: 'branch',
      businessDate: DRAWER_DAY,
    });
    await expect(recordCateringMoneyEvidence(drawer.db, scope, input)).rejects.toThrow('closed');
    expect(drawer.tx.auditLog.create).not.toHaveBeenCalled();
    expect(drawer.tx.restaurantMoneyIdempotencyKey.updateMany).not.toHaveBeenCalled();
    const drawerDay = fixture();
    vi.mocked(assertDrawerMoneyDayOpen).mockRejectedValueOnce(new Error('drawer day closed'));
    await expect(recordCateringMoneyEvidence(drawerDay.db, scope, input)).rejects.toThrow(
      'drawer day closed'
    );
    expect(drawerDay.tx.restaurantDrawerMovement.create).not.toHaveBeenCalled();
    expect(drawerDay.calls).not.toContain('evidence');
    expect(drawerDay.tx.auditLog.create).not.toHaveBeenCalled();
    expect(drawerDay.tx.restaurantMoneyIdempotencyKey.updateMany).not.toHaveBeenCalled();
  });
  it.each(['CANCELLED', 'CLOSED'])(
    'rejects new receipts on %s but replays successful receipt',
    async (status) => {
      const f = fixture();
      const result = await recordCateringMoneyEvidence(f.db, scope, input);
      f.order.status = status;
      f.quote.approvedQuoteRevisionId = null as never;
      f.quote.orderRevision++;
      expect(await recordCateringMoneyEvidence(f.db, scope, input)).toEqual({
        ...result,
        replayed: true,
      });
      for (const kind of ['DEPOSIT', 'BALANCE'] as const) {
        await expect(
          recordCateringMoneyEvidence(f.db, scope, { ...input, kind, idempotencyKey: kind })
        ).rejects.toThrow('ORDER_NOT_RECEIVABLE');
      }
      expect(f.tx.restaurantDrawerMovement.create).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['DRAFT', 'CANCELLED', 'CLOSED'])(
    'refunds historical approved receipt after revision on %s; replays once',
    async (status) => {
      const f = fixture();
      f.evidence.push(receipt);
      f.order.status = status;
      f.quote.orderRevision++;
      f.quote.approvedQuoteRevisionId = null as never;
      const command: CateringMoneyInput = {
        ...input,
        kind: 'REFUND',
        originalEvidenceId: receipt.id,
        amount: '8',
      };
      const result = await recordCateringMoneyEvidence(f.db, scope, command);
      expect(await recordCateringMoneyEvidence(f.db, scope, command)).toEqual({
        ...result,
        replayed: true,
      });
      expect(f.tx.restaurantDrawerMovement.create).toHaveBeenCalledTimes(1);
      await expect(
        recordCateringMoneyEvidence(f.db, scope, {
          ...command,
          amount: '29',
          idempotencyKey: 'over',
        })
      ).rejects.toThrow('OVER_REFUND');
    }
  );
  it.each(['device', 'capability', 'day', 'drawer'])(
    'retains current %s guard for historical refunds',
    async (guard) => {
      const f = fixture();
      f.evidence.push(receipt);
      f.order.status = 'CANCELLED';
      f.quote.orderRevision++;
      f.quote.approvedQuoteRevisionId = null as never;
      if (guard === 'device')
        f.tx.restaurantRegisteredDevice.findFirst.mockResolvedValueOnce(null as never);
      if (guard === 'capability') f.grants.push({ capability: 'payments:refund', effect: 'DENY' });
      if (guard === 'day')
        vi.mocked(assertMoneyDayOpen).mockRejectedValueOnce(new Error('day closed'));
      if (guard === 'drawer')
        f.tx.restaurantDrawerSession.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        recordCateringMoneyEvidence(f.db, scope, {
          ...input,
          kind: 'REFUND',
          originalEvidenceId: receipt.id,
        })
      ).rejects.toThrow(
        {
          device: 'ACTOR_OR_DEVICE_DENIED',
          capability: 'CAPABILITY_DENIED',
          day: 'day closed',
          drawer: 'DRAWER_DENIED',
        }[guard]
      );
      expect(f.tx.restaurantDrawerMovement.create).not.toHaveBeenCalled();
      expect(f.tx.restaurantMoneyIdempotencyKey.updateMany).not.toHaveBeenCalled();
    }
  );
  it('rejects unapproved history and a receipt from another quote or order', async () => {
    const command: CateringMoneyInput = {
      ...input,
      kind: 'REFUND',
      originalEvidenceId: receipt.id,
    };
    const unapproved = fixture();
    unapproved.evidence.push(receipt);
    unapproved.quote.approvalId = null as never;
    await expect(recordCateringMoneyEvidence(unapproved.db, scope, command)).rejects.toThrow(
      'STALE_OR_UNAPPROVED_QUOTE'
    );
    const wrongQuote = fixture();
    wrongQuote.evidence.push({ ...receipt, quoteRevisionId: 'other' });
    await expect(recordCateringMoneyEvidence(wrongQuote.db, scope, command)).rejects.toThrow(
      'ORIGINAL_MISMATCH'
    );
    const otherOrder = fixture();
    await expect(recordCateringMoneyEvidence(otherOrder.db, scope, command)).rejects.toThrow(
      'ORIGINAL_MISMATCH'
    );
    for (const f of [unapproved, wrongQuote, otherOrder])
      expect(f.tx.restaurantDrawerMovement.create).not.toHaveBeenCalled();
  });
  it('posts cash refund as PAID_OUT using exact Decimal and original receipt', async () => {
    const f = fixture();
    f.evidence.push(receipt);
    await recordCateringMoneyEvidence(f.db, scope, {
      ...input,
      amount: '8',
      kind: 'REFUND',
      originalEvidenceId: receipt.id,
    });
    expect(f.tx.restaurantDrawerMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'PAID_OUT',
          amount: new Prisma.Decimal(8),
          tenderId: null,
          refundId: null,
        }),
      })
    );
  });
});
