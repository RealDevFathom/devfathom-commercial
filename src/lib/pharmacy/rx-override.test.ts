import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  DEFAULT_RX_SELF_OVERRIDE_MAX_COUNT,
  DEFAULT_RX_SELF_OVERRIDE_MAX_VALUE_MINOR,
  RX_SELF_OVERRIDE_MAX_COUNT_KEY,
  RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY,
  rxSelfOverrideDecision,
  rxSelfOverrideLimits,
  saleLineNetMinor,
} from './rx-override';

const scope = { organizationId: 'org-1' };
const limits = { maxCount: 10, maxValueMinor: 5_000_000 };

describe('saleLineNetMinor', () => {
  it('is quantity * unit price less the line discount', () => {
    expect(saleLineNetMinor({ quantity: 3, unitPriceMinor: 1_000, discountMinor: 500 })).toBe(2_500);
  });

  it('never goes negative when a discount exceeds the gross', () => {
    expect(saleLineNetMinor({ quantity: 1, unitPriceMinor: 100, discountMinor: 1_000 })).toBe(0);
  });
});

describe('rxSelfOverrideDecision', () => {
  it('allows a self-override comfortably inside both caps', () => {
    expect(
      rxSelfOverrideDecision({ priorCount: 2, priorValueMinor: 1_000, thisValueMinor: 1_000, limits })
    ).toBeNull();
  });

  it('allows the override that exactly reaches the count and value caps', () => {
    // priorCount 9 < 10 (this is the 10th), and prior+this == maxValue (not over).
    expect(
      rxSelfOverrideDecision({
        priorCount: 9,
        priorValueMinor: 4_000_000,
        thisValueMinor: 1_000_000,
        limits,
      })
    ).toBeNull();
  });

  it('refuses once the pharmacist has already used the full count allowance', () => {
    const message = rxSelfOverrideDecision({
      priorCount: 10,
      priorValueMinor: 0,
      thisValueMinor: 1,
      limits,
    });
    expect(message).toContain('10 prescription overrides');
    expect(message).toContain('co-sign');
  });

  it('refuses when this override tips the rolling value past the cap', () => {
    const message = rxSelfOverrideDecision({
      priorCount: 1,
      priorValueMinor: 4_999_999,
      thisValueMinor: 2,
      limits,
    });
    expect(message).toContain('value limit');
    expect(message).toContain('co-sign');
  });

  it('checks the count cap before the value cap', () => {
    // Both caps breached: the count message wins so the counter sees the simpler reason.
    const message = rxSelfOverrideDecision({
      priorCount: 10,
      priorValueMinor: 5_000_000,
      thisValueMinor: 5_000_000,
      limits,
    });
    expect(message).toContain('prescription override');
    expect(message).not.toContain('value limit');
  });

  it('uses the singular when the count cap is one', () => {
    const message = rxSelfOverrideDecision({
      priorCount: 1,
      priorValueMinor: 0,
      thisValueMinor: 0,
      limits: { maxCount: 1, maxValueMinor: 5_000_000 },
    });
    expect(message).toContain('1 prescription override per day');
    expect(message).not.toContain('overrides');
  });
});

describe('rxSelfOverrideLimits', () => {
  function db(rows: Array<{ key: string; value: number }>) {
    return {
      organizationLimit: { findMany: vi.fn(async () => rows) },
    } as never;
  }

  it('falls back to the conservative defaults when nothing is configured', async () => {
    await expect(rxSelfOverrideLimits(db([]), scope, new Date())).resolves.toEqual({
      maxCount: DEFAULT_RX_SELF_OVERRIDE_MAX_COUNT,
      maxValueMinor: DEFAULT_RX_SELF_OVERRIDE_MAX_VALUE_MINOR,
    });
  });

  it('reads the per-org configured count and value limits', async () => {
    await expect(
      rxSelfOverrideLimits(
        db([
          { key: RX_SELF_OVERRIDE_MAX_COUNT_KEY, value: 3 },
          { key: RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY, value: 250_000 },
        ]),
        scope,
        new Date()
      )
    ).resolves.toEqual({ maxCount: 3, maxValueMinor: 250_000 });
  });

  it('allows a zero limit to disable self-overrides entirely', async () => {
    await expect(
      rxSelfOverrideLimits(db([{ key: RX_SELF_OVERRIDE_MAX_COUNT_KEY, value: 0 }]), scope, new Date())
    ).resolves.toMatchObject({ maxCount: 0 });
  });

  it('ignores a negative stored limit and fails closed to the default', async () => {
    await expect(
      rxSelfOverrideLimits(
        db([{ key: RX_SELF_OVERRIDE_MAX_COUNT_KEY, value: -1 }]),
        scope,
        new Date()
      )
    ).resolves.toMatchObject({ maxCount: DEFAULT_RX_SELF_OVERRIDE_MAX_COUNT });
  });

  it('only reads unexpired limit rows for the organization', async () => {
    const findMany = vi.fn(async () => []);
    const now = new Date('2026-10-21T00:00:00Z');
    await rxSelfOverrideLimits({ organizationLimit: { findMany } } as never, scope, now);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        }),
      })
    );
  });
});
