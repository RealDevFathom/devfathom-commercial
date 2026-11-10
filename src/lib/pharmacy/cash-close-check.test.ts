import { describe, expect, it } from 'vitest';
import {
  CASH_CLOSE_CHECK_POLICY,
  checkPharmacyCashClose,
  type CashCloseFacts,
} from './cash-close-check';
import { PHARMACY_ANOMALY_POLICY } from './anomaly-signals';

function facts(overrides: Partial<CashCloseFacts> = {}): CashCloseFacts {
  return {
    businessDate: '2026-10-30',
    close: {
      id: 'close_1',
      sequence: 1,
      cashExpectedMinor: 5_000_000,
      cashCountedMinor: 5_000_000,
      cashVarianceMinor: 0,
      varianceNote: null,
    },
    grossSalesMinor: 10_000_000,
    completedSales: 100,
    drawers: [{ id: 'd1', label: 'A', expectedMinor: 5_000_000, countedMinor: 5_000_000 }],
    refunds: [],
    voids: [],
    actorNames: { u1: 'Ayesha', u2: 'Bilal' },
    ...overrides,
  };
}

const kinds = (input: CashCloseFacts) => checkPharmacyCashClose(input).findings.map((f) => f.kind);

describe('cash-close anomaly check (#728)', () => {
  it('reuses the AI-04 cash-variance and unmatched-refund thresholds', () => {
    expect(CASH_CLOSE_CHECK_POLICY.cashVariance).toBe(PHARMACY_ANOMALY_POLICY.cashVariance);
    expect(CASH_CLOSE_CHECK_POLICY.unmatchedRefunds.minimum).toBe(
      PHARMACY_ANOMALY_POLICY.ghostReturn.minimumUnmatchedRefunds
    );
  });

  it('flags nothing on a clean close and says so read-only', () => {
    const check = checkPharmacyCashClose(facts());
    expect(check.findings).toEqual([]);
    expect(check.readOnly).toBe(true);
    expect(check.closed).toBe(true);
    expect(check.narrative).toContain('No rule flagged this close');
    expect(check.narrative).toContain('read-only');
  });

  it('flags close variance at the materiality floor and escalates at twice it', () => {
    // Floor = max(PKR 1,000, 1% of PKR 50,000) = PKR 1,000 = 100_000 minor.
    const below = facts({
      close: { ...facts().close!, cashCountedMinor: 4_900_001, cashVarianceMinor: -99_999 },
    });
    expect(kinds(below)).not.toContain('CLOSE_VARIANCE');
    const review = checkPharmacyCashClose(
      facts({
        close: {
          ...facts().close!,
          cashCountedMinor: 4_900_000,
          cashVarianceMinor: -100_000,
          varianceNote: 'Short',
        },
      })
    );
    expect(review.findings).toEqual([
      expect.objectContaining({
        kind: 'CLOSE_VARIANCE',
        severity: 'REVIEW',
        exactNumbers: expect.objectContaining({
          varianceMinor: -100_000,
          materialityMinor: 100_000,
        }),
      }),
    ]);
    expect(review.findings[0].explanation).toContain('short PKR 1000.00');
    // #487: the organization's currency, never a hard-coded PKR.
    const inUsd = checkPharmacyCashClose({
      ...facts({
        close: {
          ...facts().close!,
          cashCountedMinor: 4_900_000,
          cashVarianceMinor: -100_000,
          varianceNote: 'Short',
        },
      }),
      currency: 'USD',
    });
    expect(inUsd.currency).toBe('USD');
    expect(inUsd.findings[0].explanation).toContain('short USD 1000.00');
    expect(`${inUsd.narrative} ${inUsd.findings[0].explanation}`).not.toContain('PKR');
    const urgent = checkPharmacyCashClose(
      facts({
        close: {
          ...facts().close!,
          cashCountedMinor: 5_200_000,
          cashVarianceMinor: 200_000,
          varianceNote: 'Over',
        },
      })
    );
    expect(urgent.findings[0]).toMatchObject({ kind: 'CLOSE_VARIANCE', severity: 'URGENT' });
  });

  it('catches offsetting drawers hidden inside a balanced net close', () => {
    const check = checkPharmacyCashClose(
      facts({
        drawers: [
          { id: 'd1', label: 'A', expectedMinor: 2_500_000, countedMinor: 2_350_000 },
          { id: 'd2', label: 'B', expectedMinor: 2_500_000, countedMinor: 2_650_000 },
        ],
      })
    );
    expect(check.findings.map((f) => [f.kind, f.subject.drawerSessionId])).toEqual([
      ['DRAWER_VARIANCE', 'd1'],
      ['DRAWER_VARIANCE', 'd2'],
    ]);
  });

  it('does not double-report a single drawer as both close and drawer variance', () => {
    const check = checkPharmacyCashClose(
      facts({
        close: {
          ...facts().close!,
          cashCountedMinor: 4_800_000,
          cashVarianceMinor: -200_000,
          varianceNote: 'x',
        },
        drawers: [{ id: 'd1', label: 'A', expectedMinor: 5_000_000, countedMinor: 4_800_000 }],
      })
    );
    expect(check.findings.map((f) => f.kind)).toEqual(['CLOSE_VARIANCE']);
  });

  it('notes a recorded variance with no explanation', () => {
    const check = checkPharmacyCashClose(
      facts({
        close: { ...facts().close!, cashCountedMinor: 4_999_000, cashVarianceMinor: -1_000 },
      })
    );
    expect(check.findings).toEqual([
      expect.objectContaining({ kind: 'VARIANCE_WITHOUT_NOTE', severity: 'NOTICE' }),
    ]);
  });

  it('flags a high refund rate and refunds on a day with no sales', () => {
    const refunds = [
      { id: 'r1', saleId: 's1', actorId: 'u1', amountMinor: 600_000, matchedReturn: true },
      { id: 'r2', saleId: 's2', actorId: 'u2', amountMinor: 600_000, matchedReturn: true },
    ];
    const check = checkPharmacyCashClose(facts({ refunds }));
    expect(check.findings).toEqual([
      expect.objectContaining({
        kind: 'REFUND_RATE',
        severity: 'REVIEW',
        exactNumbers: expect.objectContaining({
          refundRateBps: 1_200,
          refundTotalMinor: 1_200_000,
        }),
      }),
    ]);
    expect(
      checkPharmacyCashClose(facts({ refunds, grossSalesMinor: 0, completedSales: 0 })).findings[0]
    ).toMatchObject({ kind: 'REFUND_RATE', severity: 'URGENT' });
    // Small refund totals stay below the absolute floor however high the rate.
    expect(
      kinds(
        facts({
          grossSalesMinor: 10_000,
          refunds: [{ ...refunds[0], amountMinor: 5_000 }],
        })
      )
    ).not.toContain('REFUND_RATE');
  });

  it('flags refunds without a stock-return record', () => {
    const unmatched = [1, 2, 3, 4].map((n) => ({
      id: `r${n}`,
      saleId: `s${n}`,
      actorId: n % 2 ? 'u1' : 'u2',
      amountMinor: 1_000,
      matchedReturn: false,
    }));
    expect(kinds(facts({ refunds: unmatched.slice(0, 1) }))).not.toContain('UNMATCHED_REFUNDS');
    expect(checkPharmacyCashClose(facts({ refunds: unmatched.slice(0, 2) })).findings).toEqual([
      expect.objectContaining({ kind: 'UNMATCHED_REFUNDS', severity: 'REVIEW' }),
    ]);
    expect(checkPharmacyCashClose(facts({ refunds: unmatched })).findings[0]).toMatchObject({
      kind: 'UNMATCHED_REFUNDS',
      severity: 'URGENT',
      exactNumbers: { unmatchedRefunds: 4, unmatchedAmountMinor: 4_000, thresholdRefunds: 2 },
    });
  });

  it('flags void volume by rate and by absolute count', () => {
    const voids = (count: number, actor = (n: number) => (n % 2 ? 'u1' : 'u2')) =>
      Array.from({ length: count }, (_, n) => ({
        saleId: `v${n}`,
        actorId: actor(n),
        valueMinor: 1_000,
      }));
    expect(kinds(facts({ voids: voids(3), completedSales: 100 }))).not.toContain('VOID_VOLUME');
    expect(checkPharmacyCashClose(facts({ voids: voids(3), completedSales: 20 })).findings).toEqual(
      [expect.objectContaining({ kind: 'VOID_VOLUME', severity: 'REVIEW' })]
    );
    expect(
      checkPharmacyCashClose(facts({ voids: voids(10), completedSales: 1_000 })).findings[0]
    ).toMatchObject({ kind: 'VOID_VOLUME', severity: 'URGENT' });
  });

  it('notes refunds and voids concentrated on one team member without assigning blame', () => {
    const check = checkPharmacyCashClose(
      facts({
        refunds: [
          { id: 'r1', saleId: 's1', actorId: 'u1', amountMinor: 1_000, matchedReturn: true },
          { id: 'r2', saleId: 's2', actorId: 'u1', amountMinor: 1_000, matchedReturn: true },
          { id: 'r3', saleId: 's3', actorId: 'u2', amountMinor: 1_000, matchedReturn: true },
        ],
        voids: [
          { saleId: 'v1', actorId: 'u1', valueMinor: 1_000 },
          { saleId: 'v2', actorId: 'u1', valueMinor: 1_000 },
        ],
      })
    );
    const finding = check.findings.find((f) => f.kind === 'ACTOR_CONCENTRATION');
    expect(finding).toMatchObject({
      severity: 'NOTICE',
      subject: { actorId: 'u1' },
      exactNumbers: { actorEvents: 4, totalEvents: 5, shareBps: 8_000 },
    });
    expect(finding!.explanation).toContain('Ayesha');
    expect(check.narrative).toContain('not findings of misconduct');
    // A sole operator is not a concentration.
    expect(
      kinds(
        facts({
          voids: [1, 2, 3].map((n) => ({ saleId: `v${n}`, actorId: 'u1', valueMinor: 1 })),
        })
      )
    ).not.toContain('ACTOR_CONCENTRATION');
  });

  it('previews an open day and waits for every drawer count before judging variance', () => {
    const open = facts({
      close: null,
      drawers: [
        { id: 'd1', label: 'A', expectedMinor: 2_500_000, countedMinor: 2_000_000 },
        { id: 'd2', label: 'B', expectedMinor: 2_500_000, countedMinor: null },
      ],
    });
    const check = checkPharmacyCashClose(open);
    expect(check.closed).toBe(false);
    expect(check.totals.cashCountedMinor).toBeNull();
    expect(check.findings.map((f) => f.kind)).toEqual(['DRAWER_VARIANCE']);
    expect(check.narrative).toContain('still open');
    expect(check.narrative).toContain('not every drawer has been counted');
  });

  it('orders findings by severity and does not mutate its input', () => {
    const input = facts({
      close: { ...facts().close!, cashCountedMinor: 4_700_000, cashVarianceMinor: -300_000 },
      refunds: [
        { id: 'r1', saleId: 's1', actorId: 'u1', amountMinor: 1_000, matchedReturn: false },
        { id: 'r2', saleId: 's2', actorId: 'u2', amountMinor: 1_000, matchedReturn: false },
      ],
    });
    const snapshot = structuredClone(input);
    const check = checkPharmacyCashClose(input);
    expect(check.findings.map((f) => f.severity)).toEqual(['URGENT', 'REVIEW', 'NOTICE']);
    expect(input).toEqual(snapshot);
  });
});
