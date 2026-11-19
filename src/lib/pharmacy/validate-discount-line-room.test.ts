/**
 * DEV-966: `validateDiscount` (an item discount) uses the one shared line-room rule,
 * `lineDiscountRoomMinor`, that the whole-bill discount also uses. Its decisions are identical to
 * the inline rule it had before: the same accept, the same refusal reason and the same thrown
 * error, on every input.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./smart-discount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./smart-discount')>();
  return { ...actual, lineDiscountRoomMinor: vi.fn(actual.lineDiscountRoomMinor) };
});

import { PharmacySaleError, validateDiscount } from './sales';
import {
  lineDiscountRoomMinor,
  maxDiscountMinorFor,
  minimumPriceForMargin,
} from './smart-discount';

type Input = Parameters<typeof validateDiscount>[0];

/** The rule exactly as `validateDiscount` held it inline before DEV-966 (develop at 0d83f908c). */
function validateDiscountBefore(input: Input) {
  if (input.discountMinor < 0 || input.discountMinor > input.grossMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
  if (input.regulated && input.discountMinor > 0)
    throw new PharmacySaleError('REGULATED_DISCOUNT_REFUSED');
  if (input.discountMinor > 0 && (!input.approvedByUserId || !input.approvalPolicy))
    throw new PharmacySaleError('APPROVAL_REQUIRED');
  if (input.discountMinor > maxDiscountMinorFor(input.grossMinor, input.maxDiscountBps))
    throw new PharmacySaleError('DISCOUNT_ABOVE_MAXIMUM');
  if (input.grossMinor - input.discountMinor < input.costMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
  if (
    input.discountMinor > 0 &&
    input.grossMinor - input.discountMinor <
      minimumPriceForMargin(input.costMinor, input.minMarginBps ?? 0)
  )
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
}

/** The decision: accepted, or the error's kind and reason (or message). */
function decision(run: () => void) {
  try {
    run();
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof PharmacySaleError) return `PharmacySaleError:${error.reason}`;
    if (error instanceof Error) return `${error.name}:${error.message}`;
    throw error;
  }
}

/** Deterministic 32-bit generator, so a failure reproduces from the case number. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]) => values[int(0, values.length - 1)]!;
  return { next, int, pick };
}

function randomInput(r: ReturnType<typeof generator>): Input {
  const grossMinor = r.pick([0, 1, 2, 99, 100, 101, 9_999, r.int(0, 500), r.int(0, 2_000_000)]);
  const costMinor = r.pick([
    0,
    grossMinor,
    grossMinor + 1,
    Math.max(0, grossMinor - 1),
    r.int(0, Math.max(1, grossMinor)),
    r.int(0, Math.max(1, Math.ceil(grossMinor * 1.5))),
  ]);
  const minMarginBps = r.pick([undefined, 0, 1, 2_000, 5_000, 9_000, r.int(0, 9_000)]);
  const maxDiscountBps = r.pick([0, 1, 1_000, 2_500, 5_000, 9_999, 10_000, r.int(0, 10_000)]);
  // Discounts bunch around every boundary the rule draws, so each refusal is reached often.
  const maximum = maxDiscountMinorFor(grossMinor, maxDiscountBps);
  const marginRoom = grossMinor - minimumPriceForMargin(costMinor, minMarginBps ?? 0);
  const around = (n: number) => n + r.int(-2, 2);
  const discountMinor = r.pick([
    0,
    -1,
    grossMinor,
    grossMinor + 1,
    around(maximum),
    around(marginRoom),
    around(grossMinor - costMinor),
    r.int(0, Math.max(0, grossMinor)),
  ]);
  const approved = r.next() < 0.85;
  return {
    regulated: r.next() < 0.1,
    discountMinor,
    grossMinor,
    costMinor,
    approvedByUserId: approved || r.next() < 0.5 ? 'approver' : undefined,
    approvalPolicy: approved ? 'MANAGER_PIN' : r.pick([undefined, '']),
    ...(minMarginBps === undefined ? {} : { minMarginBps }),
    maxDiscountBps,
  };
}

/** Inputs no real line carries, so the thrown errors are compared as well. */
function malformedInput(r: ReturnType<typeof generator>): Input {
  const base = randomInput(r);
  const fault = r.int(0, 5);
  if (fault === 0) return { ...base, costMinor: -r.int(1, 100) };
  if (fault === 1) return { ...base, costMinor: base.costMinor + 0.5 };
  if (fault === 2) return { ...base, minMarginBps: r.pick([-1, 10_000, 12_000, 1.5]) };
  if (fault === 3) return { ...base, grossMinor: base.grossMinor + 0.5 };
  if (fault === 4) return { ...base, maxDiscountBps: r.pick([-1, 10_001, 2.5, Number.NaN]) };
  return { ...base, discountMinor: r.pick([Number.NaN, 0.5, base.discountMinor + 0.25]) };
}

describe('DEV-966 validateDiscount uses the shared line-room rule', () => {
  it('asks lineDiscountRoomMinor for the room of a discounted line', () => {
    vi.mocked(lineDiscountRoomMinor).mockClear();
    validateDiscount({
      regulated: false,
      discountMinor: 20,
      grossMinor: 100,
      costMinor: 50,
      approvedByUserId: 'approver',
      approvalPolicy: 'MANAGER_PIN',
      minMarginBps: 2_000,
      maxDiscountBps: 5_000,
    });
    expect(lineDiscountRoomMinor).toHaveBeenCalledWith({
      grossMinor: 100,
      costMinor: 50,
      minMarginBps: 2_000,
      maxDiscountBps: 5_000,
    });
    // The room it gives decides: 100 - ceil(50 / 0.8) = 37 here.
    expect(() =>
      validateDiscount({
        regulated: false,
        discountMinor: 38,
        grossMinor: 100,
        costMinor: 50,
        approvedByUserId: 'approver',
        approvalPolicy: 'MANAGER_PIN',
        minMarginBps: 2_000,
        maxDiscountBps: 5_000,
      })
    ).toThrow(expect.objectContaining({ reason: 'MARGIN_GUARDRAIL' }));
  });

  it('decides exactly as the old inline rule on 200,000 random item discounts', () => {
    const r = generator(966);
    const outcomes = new Map<string, number>();
    const differences: { index: number; input: Input; before: string; after: string }[] = [];
    for (let index = 0; index < 200_000; index += 1) {
      const input = randomInput(r);
      const before = decision(() => validateDiscountBefore(input));
      const after = decision(() => validateDiscount(input));
      outcomes.set(after, (outcomes.get(after) ?? 0) + 1);
      if (before !== after && differences.length < 5)
        differences.push({ index, input, before, after });
    }
    expect(differences).toEqual([]);
    // Every decision the rule makes is exercised many times, so the comparison is not vacuous.
    for (const outcome of [
      'ACCEPTED',
      'PharmacySaleError:MARGIN_GUARDRAIL',
      'PharmacySaleError:REGULATED_DISCOUNT_REFUSED',
      'PharmacySaleError:APPROVAL_REQUIRED',
      'PharmacySaleError:DISCOUNT_ABOVE_MAXIMUM',
    ])
      expect(outcomes.get(outcome) ?? 0).toBeGreaterThan(1_000);
  });

  it('throws the same error as the old inline rule on 20,000 malformed inputs', () => {
    const r = generator(9_660);
    const differences: { index: number; input: Input; before: string; after: string }[] = [];
    const thrown = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) {
      const input = malformedInput(r);
      const before = decision(() => validateDiscountBefore(input));
      const after = decision(() => validateDiscount(input));
      if (after.startsWith('RangeError')) thrown.add(after);
      if (before !== after && differences.length < 5)
        differences.push({ index, input, before, after });
    }
    expect(differences).toEqual([]);
    expect(thrown).toEqual(
      new Set(['RangeError:costMinor', 'RangeError:minMarginBps', 'RangeError:grossMinor'])
    );
  });
});
