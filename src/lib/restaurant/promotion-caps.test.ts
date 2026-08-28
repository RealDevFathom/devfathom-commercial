import { describe, expect, it, vi } from 'vitest';

import {
  capKeyFor,
  claimCapSlotsWithRetry,
  isCapSlotConflict,
  planCapClaims,
  PromotionCapContentionError,
  PromotionCapExhaustedError,
  tightestRemaining,
  TOTAL_CAP_KEY,
  type PromotionCapScope,
} from './promotion-caps';

/**
 * WHA-288 — cap KEYING and RETRY policy (the pure half).
 *
 * The concurrency proof itself needs a real database and lives in
 * tests/restaurant-promotions-cap-concurrency.test.ts. What is testable without
 * one is the part that decides WHAT to claim and HOW to react to losing a race —
 * and those decisions are where a cap gets quietly defeated.
 */

const SUBJECT = { orderId: 'order_1', customerId: 'customer_1' };

describe('cap keys', () => {
  it('keys PER_ORDER on the order, PER_GUEST on the customer, TOTAL on the shared pool', () => {
    expect(capKeyFor('PER_ORDER', SUBJECT)).toBe('order_1');
    expect(capKeyFor('PER_GUEST', SUBJECT)).toBe('customer_1');
    expect(capKeyFor('TOTAL', SUBJECT)).toBe(TOTAL_CAP_KEY);
  });

  it('cannot key a PER_GUEST cap for a walk-in with no customer record', () => {
    expect(capKeyFor('PER_GUEST', { orderId: 'order_1', customerId: null })).toBeNull();
  });

  it('refuses the promotion when a per-guest cap cannot be keyed, rather than waiving it', () => {
    // An anonymous guest must not be the way to defeat a once-per-customer cap.
    expect(() =>
      planCapClaims('version_1', [{ scope: 'PER_GUEST', maxRedemptions: 1 }], {
        orderId: 'order_1',
        customerId: null,
      })
    ).toThrow(PromotionCapExhaustedError);
  });
});

describe('claim planning', () => {
  it('always claims caps in the same scope order so two writers cannot deadlock', () => {
    const caps = [
      { scope: 'TOTAL' as PromotionCapScope, maxRedemptions: 100 },
      { scope: 'PER_GUEST' as PromotionCapScope, maxRedemptions: 1 },
      { scope: 'PER_ORDER' as PromotionCapScope, maxRedemptions: 1 },
    ];
    const forward = planCapClaims('version_1', caps, SUBJECT);
    const reversed = planCapClaims('version_1', [...caps].reverse(), SUBJECT);
    expect(forward.map((claim) => claim.scope)).toEqual(['PER_ORDER', 'PER_GUEST', 'TOTAL']);
    expect(reversed.map((claim) => claim.scope)).toEqual(forward.map((claim) => claim.scope));
  });

  it('plans nothing for a version with no caps', () => {
    expect(planCapClaims('version_1', [], SUBJECT)).toEqual([]);
  });

  it('carries each cap ceiling through to its claim', () => {
    expect(planCapClaims('version_1', [{ scope: 'TOTAL', maxRedemptions: 100 }], SUBJECT)).toEqual([
      { scope: 'TOTAL', capKey: TOTAL_CAP_KEY, maxRedemptions: 100 },
    ]);
  });
});

describe('conflict detection', () => {
  it('recognises a raw PostgreSQL unique violation', () => {
    expect(isCapSlotConflict({ code: '23505' })).toBe(true);
  });

  it('recognises the Prisma unique-constraint wrapper and its nested driver code', () => {
    expect(isCapSlotConflict({ code: 'P2002' })).toBe(true);
    expect(isCapSlotConflict({ meta: { code: '23505' } })).toBe(true);
  });

  it('recognises the shape a raw query through the driver adapter actually throws', () => {
    // P2010 with the real SQLSTATE buried two levels down — the shape observed
    // from $queryRawUnsafe. Missing this would turn a retryable race into a
    // refused discount.
    expect(
      isCapSlotConflict({
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: { kind: 'UniqueConstraintViolation', originalCode: '23505' },
          },
        },
      })
    ).toBe(true);
  });

  it('does not treat an unrelated driver-adapter failure as a race', () => {
    expect(
      isCapSlotConflict({
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: { kind: 'ForeignKeyViolation', originalCode: '23503' },
          },
        },
      })
    ).toBe(false);
  });

  it('does not swallow an unrelated failure', () => {
    expect(isCapSlotConflict({ code: '23503' })).toBe(false);
    expect(isCapSlotConflict(new Error('connection reset'))).toBe(false);
    expect(isCapSlotConflict(null)).toBe(false);
  });
});

describe('bounded retry', () => {
  it('returns as soon as an attempt wins its ordinal', async () => {
    const attempt = vi.fn().mockResolvedValue('claimed');
    await expect(claimCapSlotsWithRetry('version_1', attempt)).resolves.toBe('claimed');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries only the ordinal race, and only until it wins', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce({ code: '23505' })
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValue('claimed');
    await expect(claimCapSlotsWithRetry('version_1', attempt)).resolves.toBe('claimed');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('propagates a non-conflict failure immediately instead of burning the budget', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(claimCapSlotsWithRetry('version_1', attempt)).rejects.toThrow('connection reset');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up with a contention error rather than dropping the claim silently', async () => {
    const attempt = vi.fn().mockRejectedValue({ code: '23505' });
    await expect(
      claimCapSlotsWithRetry('version_1', attempt, { maxAttempts: 3 })
    ).rejects.toBeInstanceOf(PromotionCapContentionError);
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

describe('remaining allowance', () => {
  it('takes the tightest cap as the version-level allowance', () => {
    expect(
      tightestRemaining(
        new Map<PromotionCapScope, number>([
          ['TOTAL', 40],
          ['PER_GUEST', 0],
        ])
      )
    ).toBe(0);
  });

  it('is unbounded when a version carries no caps', () => {
    expect(tightestRemaining(new Map())).toBe(Number.POSITIVE_INFINITY);
  });
});
