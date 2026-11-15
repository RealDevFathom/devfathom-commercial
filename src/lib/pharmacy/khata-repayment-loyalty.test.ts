import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./bookkeeping', async (original) => ({
  ...(await original<typeof import('./bookkeeping')>()),
  postBookkeepingTransaction: vi.fn(),
}));

import { postBookkeepingTransaction } from './bookkeeping';
import { readKhataBalance } from './family-khata';
import { recordKhataRepayment, type KhataRepaymentInput } from './khata-repayment';
import { earnKhataCollectionPoints } from './loyalty-khata-earn';

/**
 * DEV-746: a khata sale earns loyalty points when its debt is paid at the counter.
 * The counter repayment service is the one place that settles the debt; these tests hold
 * it to settling once and earning once, including when the cashier's submit is retried.
 */
const scope = { organizationId: 'org_k', branchId: 'branch_k', actorId: 'cashier_1' };
const businessDate = new Date('2026-11-15');
const input: KhataRepaymentInput = {
  familyAccountId: 'family_1',
  amountMinor: 30_000,
  tender: 'CASH',
  deviceId: 'device_1',
  businessDate,
  idempotencyKey: 'attempt-1',
};
// 2% of spend: 200 basis points over 1,000,000.
const twoPercent = {
  id: 'program_1',
  version: 1,
  earnMode: 'PERCENT_OF_SPEND',
  earnPoints: 200,
  perSpendMinor: 1_000_000,
};

type Row = Record<string, unknown>;

function store(
  options: {
    program?: Row | null;
    granted?: boolean;
    legacyEarn?: boolean;
    refundedMinor?: number;
    events?: Row[];
  } = {}
) {
  const events: Row[] = options.events ?? [
    {
      id: 'khata:tender_credit',
      kind: 'CHARGE',
      amountMinor: 50_000,
      occurredAt: new Date('2026-10-01'),
    },
  ];
  const points: Row[] = options.legacyEarn
    ? [{ id: 'legacy', kind: 'EARN', saleId: 'sale_1', programVersionId: null, points: 500 }]
    : [];
  const receipts: Row[] = [];
  let sequence = 0;
  const db = {
    $queryRaw: vi.fn(async (query: { strings: string[] }) => {
      const sql = query.strings.join('');
      if (sql.includes('FROM pharmacy_patients')) return [{ id: 'patient_1' }];
      if (sql.includes('"patientId" FROM pharmacy_customers')) return [{ patientId: 'patient_1' }];
      return [];
    }),
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR' }) },
    pharmacyFamilyAccount: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'family_1', displayName: 'Khan family', active: true }),
    },
    pharmacyBookkeepingTransaction: {
      findFirst: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          receipts.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null
      ),
    },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue({ id: 'drawer_1', businessDate }),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerMovement: {
      create: vi.fn().mockResolvedValue({ id: 'movement_1' }),
      findFirst: vi.fn().mockResolvedValue({ drawerSession: { deviceId: 'device_1' } }),
    },
    pharmacyKhataEvent: {
      findMany: vi.fn(async () => events),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `payment_${++sequence}`, ...data };
        events.push(row);
        return row;
      }),
      groupBy: vi.fn(async () =>
        ['CHARGE', 'PAYMENT'].map((kind) => ({
          kind,
          _sum: {
            amountMinor: events
              .filter((event) => event.kind === kind)
              .reduce((sum, event) => sum + (event.amountMinor as number), 0),
          },
        }))
      ),
      aggregate: vi.fn(
        async ({ where }: { where: { settlesChargeId: string; id: { not: string } } }) => ({
          _sum: {
            amountMinor: events
              .filter(
                (event) =>
                  event.kind === 'PAYMENT' &&
                  event.settlesChargeId === where.settlesChargeId &&
                  event.id !== where.id.not &&
                  !String(event.id).startsWith('khata-refund:')
              )
              .reduce((sum, event) => sum + (event.amountMinor as number), 0),
          },
        })
      ),
    },
    pharmacyTender: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; type: string } }) =>
        where.id === 'tender_credit' && where.type === 'CREDIT'
          ? {
              id: 'tender_credit',
              saleId: 'sale_1',
              amountMinor: 50_000,
              sale: { customerId: 'customer_1' },
              refunds: options.refundedMinor ? [{ amountMinor: options.refundedMinor }] : [],
            }
          : null
      ),
    },
    pharmacyLoyaltyProgramVersion: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.program === undefined ? twoPercent : options.program),
    },
    pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ patientId: 'patient_1' }) },
    patientConsent: {
      findFirst: vi.fn().mockResolvedValue({ granted: options.granted ?? true, revokedAt: null }),
    },
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId_idempotencyKey: { idempotencyKey: string } };
        }) =>
          points.find(
            (row) => row.idempotencyKey === where.organizationId_idempotencyKey.idempotencyKey
          ) ?? null
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          points.find(
            (row) =>
              row.saleId === where.saleId &&
              row.kind === where.kind &&
              row.programVersionId === where.programVersionId
          ) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        // The ledger's unique idempotency key: a second earn for one payment cannot land.
        if (points.some((row) => row.idempotencyKey === data.idempotencyKey))
          throw new Error('Unique constraint failed on idempotencyKey');
        const row = { id: `points_${points.length + 1}`, ...data };
        points.push(row);
        return row;
      }),
    },
  };
  vi.mocked(postBookkeepingTransaction).mockImplementation(async (_db, txScope, receipt) => {
    receipts.push({
      ...receipt,
      branchId: txScope.branchId,
      allocations: (receipt.allocations ?? []).map((row) => ({ sourceId: row.sourceId })),
    });
    return {} as never;
  });
  return { db, events, points, receipts };
}

const khataEarns = (points: Row[]) => points.filter((row) => row.kind === 'KHATA_EARN');
const balance = (db: unknown) => readKhataBalance(db as never, scope, 'family_1');

beforeEach(() => vi.clearAllMocks());

describe('DEV-746 khata points are earned when the debt is paid', () => {
  it('a counter repayment reduces the khata balance once and earns points once', async () => {
    const { db, events, points, receipts } = store();
    expect(await balance(db)).toBe(50_000);

    const slip = await recordKhataRepayment(db as never, scope, input);

    // Settled exactly once: one PAYMENT for the amount, one receipt, balance down by it.
    const payments = events.filter((event) => event.kind === 'PAYMENT');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      settlesChargeId: 'khata:tender_credit',
      amountMinor: 30_000,
    });
    expect(receipts).toHaveLength(1);
    expect(slip.balanceAfterMinor).toBe(20_000);
    expect(await balance(db)).toBe(20_000);
    // Earned exactly once: 2% of PKR 300 = 6 points, for the customer on the khata sale.
    expect(khataEarns(points)).toEqual([
      expect.objectContaining({
        kind: 'KHATA_EARN',
        customerId: 'customer_1',
        saleId: 'sale_1',
        tenderId: 'tender_credit',
        points: 6,
        netPaidMinor: 30_000,
        earnStartMinor: 0,
        programVersionId: 'program_1',
        idempotencyKey: `loyalty:khata-earn:${payments[0]!.id}`,
      }),
    ]);
  });

  it('a retried repayment neither settles again nor earns twice', async () => {
    const { db, events, points, receipts } = store();
    const first = await recordKhataRepayment(db as never, scope, input);
    const retry = await recordKhataRepayment(db as never, scope, input);

    expect(retry).toMatchObject({
      receiptReference: first.receiptReference,
      replayed: true,
    });
    expect(events.filter((event) => event.kind === 'PAYMENT')).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(await balance(db)).toBe(20_000);
    expect(khataEarns(points)).toHaveLength(1);
    expect(points.reduce((sum, row) => sum + (row.points as number), 0)).toBe(6);
  });

  it('never earns twice for one payment even if earning is asked again', async () => {
    const { db, events, points } = store();
    await recordKhataRepayment(db as never, scope, input);
    const payments = events.filter((event) => event.kind === 'PAYMENT') as never[];
    await expect(earnKhataCollectionPoints(db as never, scope, payments)).resolves.toEqual([]);
    expect(khataEarns(points)).toHaveLength(1);
  });

  it('instalments together earn what one payment of the total would', async () => {
    const step = {
      id: 'program_2',
      version: 2,
      earnMode: 'POINTS_PER_SPEND_STEP',
      earnPoints: 1,
      perSpendMinor: 100_000,
    };
    const { db, points } = store({
      program: step,
      events: [
        {
          id: 'khata:tender_credit',
          kind: 'CHARGE',
          amountMinor: 250_000,
          occurredAt: new Date('2026-10-01'),
        },
      ],
    });
    vi.mocked(db.pharmacyTender.findFirst).mockImplementation(async () => ({
      id: 'tender_credit',
      saleId: 'sale_1',
      amountMinor: 250_000,
      sale: { customerId: 'customer_1' },
      refunds: [],
    }));
    for (const [key, amountMinor] of [
      ['a', 60_000],
      ['b', 60_000],
      ['c', 130_000],
    ] as const)
      await recordKhataRepayment(db as never, scope, {
        ...input,
        amountMinor,
        idempotencyKey: key,
      });
    // 1 point per PKR 1,000 on PKR 2,500 collected = 2 points, the second instalment
    // crossing the first PKR 1,000 and the third the second.
    expect(khataEarns(points).map((row) => [row.earnStartMinor, row.points])).toEqual([
      [60_000, 1],
      [120_000, 1],
    ]);
  });

  it('does not earn again on a sale that already earned its credit at sale time', async () => {
    const { db, points } = store({ legacyEarn: true });
    await recordKhataRepayment(db as never, scope, input);
    expect(khataEarns(points)).toHaveLength(0);
    expect(await balance(db)).toBe(20_000);
  });

  it('earns nothing without an owner-set rate or without current consent', async () => {
    const noRate = store({ program: null });
    await recordKhataRepayment(noRate.db as never, scope, input);
    expect(khataEarns(noRate.points)).toHaveLength(0);

    const withdrawn = store({ granted: false });
    await recordKhataRepayment(withdrawn.db as never, scope, input);
    expect(khataEarns(withdrawn.points)).toHaveLength(0);
    // The debt is still settled: consent governs points, not the repayment.
    expect(await balance(withdrawn.db)).toBe(20_000);
  });

  it('earns only on money still owed after a refund of the credit tender', async () => {
    const { db, points } = store({ refundedMinor: 40_000 });
    await recordKhataRepayment(db as never, scope, input);
    // PKR 500 credit, PKR 400 refunded: only PKR 100 of the PKR 300 paid can earn (2 points).
    expect(khataEarns(points)).toEqual([
      expect.objectContaining({ points: 2, netPaidMinor: 10_000, earnStartMinor: 0 }),
    ]);
  });
});
