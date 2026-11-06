import { describe, expect, it } from 'vitest';
import { multiplyMoney, roundMoney } from './money';
import {
  centsToMoney,
  computeInvoiceAmounts,
  DISCOUNT_EXCEEDS_SUBTOTAL_MESSAGE,
  INVOICE_AMOUNT_RANGE_MESSAGE,
  INVOICE_NEGATIVE_MESSAGE,
  lineAmountCents,
  moneyToCents,
} from './invoice-amounts';

const line = (quantity: number, rate: number, description = 'Work') => ({
  description,
  quantity,
  rate,
});

/** Sum persisted 2-decimal amounts exactly, the way Postgres adds Decimal(12,2). */
const exactSum = (values: number[]) =>
  values.reduce((sum, value) => sum + (moneyToCents(value) as bigint), BigInt(0));

function amountsOf(input: Parameters<typeof computeInvoiceAmounts>[0]) {
  const result = computeInvoiceAmounts(input);
  if (!result.ok) throw new Error(`expected amounts, got ${result.message}`);
  return result.amounts;
}

describe('invoice rounding contract', () => {
  it('rounds each line to cents half-up before summing (3 × 0.335 = 1.005 → 1.01)', () => {
    const amounts = amountsOf({ items: [line(3, 0.335), line(3, 0.335), line(3, 0.335)] });

    expect(amounts.items.map((item) => item.amount)).toEqual([1.01, 1.01, 1.01]);
    // Rounding the unrounded sum (3.015 → 3.02) would disagree with the lines.
    expect(amounts.subtotal).toBe(3.03);
    expect(amounts.total).toBe(3.03);
  });

  it('keeps a 1/3 rate consistent: the lines persisted are the lines summed', () => {
    const third = 1 / 3; // 0.3333333333333333
    const amounts = amountsOf({
      items: [line(1, third), line(1, third), line(1, third)],
      discount: third,
      tax: third,
    });

    expect(amounts.items.map((item) => item.amount)).toEqual([0.33, 0.33, 0.33]);
    expect(amounts.subtotal).toBe(0.99);
    expect(amounts.discount).toBe(0.33);
    expect(amounts.tax).toBe(0.33);
    expect(amounts.total).toBe(0.99);
  });

  it('multiplies exactly in decimal where binary floating point drifts', () => {
    // 1.005 * 1000 === 1004.9999999999999 in float; decimal is exactly 1005.
    expect(lineAmountCents(1000, 1.005)).toBe(BigInt(100500));
    expect(lineAmountCents(1, 1.005)).toBe(BigInt(101));
    expect(lineAmountCents(0.1, 0.2)).toBe(BigInt(2));
    expect(lineAmountCents(2.5, 4.2)).toBe(BigInt(1050));
    expect(lineAmountCents(1e3, 1.005e-3)).toBe(BigInt(101));
    expect(lineAmountCents(1_000_000, 9_999.99)).toBe(BigInt(999999000000));
  });

  it('rounds half-cents up and everything below a half-cent down', () => {
    expect(moneyToCents(0.005)).toBe(BigInt(1));
    expect(moneyToCents(0.0049999)).toBe(BigInt(0));
    expect(moneyToCents(2.675)).toBe(BigInt(268));
    expect(moneyToCents('12.345')).toBe(BigInt(1235));
    expect(moneyToCents(Number.NaN)).toBeNull();
    expect(moneyToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('agrees with the existing Decimal money helpers on every awkward value', () => {
    const values = [0.335, 1.005, 2.675, 1 / 3, 2 / 3, 0.1, 0.7, 19.995, 1234.565, 0.045];
    const quantities = [1, 2, 3, 7, 0.5, 1.5, 12.25, 1 / 3];
    for (const rate of values) {
      expect(centsToMoney(moneyToCents(rate) as bigint)).toBe(roundMoney(rate));
      for (const quantity of quantities) {
        expect(centsToMoney(lineAmountCents(quantity, rate) as bigint)).toBe(
          multiplyMoney(quantity, rate)
        );
      }
    }
  });

  it('persists line amounts that always add up to the persisted subtotal and total', () => {
    const rates = [0.335, 1 / 3, 2 / 3, 0.005, 19.995, 0.07, 1.115, 33.335];
    for (let count = 1; count <= rates.length; count++) {
      const items = rates.slice(0, count).map((rate, index) => line(index + 1, rate));
      const amounts = amountsOf({ items, discount: 0.005, tax: 1 / 3 });

      expect(exactSum(amounts.items.map((item) => item.amount))).toBe(
        moneyToCents(amounts.subtotal)
      );
      expect(moneyToCents(amounts.total)).toBe(
        (moneyToCents(amounts.subtotal) as bigint) -
          (moneyToCents(amounts.discount) as bigint) +
          (moneyToCents(amounts.tax) as bigint)
      );
      for (const value of [amounts.subtotal, amounts.discount, amounts.tax, amounts.total]) {
        expect(String(value)).toMatch(/^\d+(\.\d{1,2})?$/);
      }
    }
  });

  it('computes total = subtotal − discount + tax', () => {
    expect(amountsOf({ items: [line(2, 50)], discount: 15.5, tax: 8.25 })).toEqual({
      items: [{ description: 'Work', quantity: 2, rate: 50, amount: 100 }],
      subtotal: 100,
      discount: 15.5,
      tax: 8.25,
      total: 92.75,
    });
  });

  it('allows a discount equal to the subtotal (tax is still owed)', () => {
    expect(amountsOf({ items: [line(1, 100)], discount: 100, tax: 5 }).total).toBe(5);
  });

  it('defaults a missing discount and tax to zero', () => {
    const amounts = amountsOf({ items: [line(1, 10)], discount: null });
    expect(amounts).toMatchObject({ subtotal: 10, discount: 0, tax: 0, total: 10 });
  });
});

describe('invoice amount rejections', () => {
  it.each([
    ['a discount above the subtotal', { items: [line(1, 100)], discount: 100.01 }, 'discount'],
    // A 0.004 line rounds to a 0.00 subtotal; a 0.005 discount rounds to 0.01.
    [
      'a discount that rounds above the subtotal',
      { items: [line(1, 0.004)], discount: 0.005 },
      'discount',
    ],
  ])('refuses %s', (_label, input, field) => {
    expect(computeInvoiceAmounts(input)).toEqual({
      ok: false,
      field,
      message: DISCOUNT_EXCEEDS_SUBTOTAL_MESSAGE,
    });
  });

  it.each([
    ['discount', { items: [line(1, 10)], discount: -0.01 }],
    ['discount', { items: [line(1, 10)], discount: -0.001 }],
    ['tax', { items: [line(1, 10)], tax: -1 }],
    ['items', { items: [line(1, -10)] }],
    ['items', { items: [line(-1, 10)] }],
    ['discount', { items: [line(1, 10)], discount: Number.NaN }],
  ])('refuses a negative or non-numeric %s', (field, input) => {
    expect(computeInvoiceAmounts(input)).toEqual({
      ok: false,
      field,
      message: INVOICE_NEGATIVE_MESSAGE,
    });
  });

  it.each([
    ['items', { items: [line(2, 9_999_999_999.99)] }],
    ['subtotal', { items: [line(1, 5_000_000_000), line(1, 5_000_000_000)] }],
    ['tax', { items: [line(1, 1)], tax: 10_000_000_000 }],
    ['total', { items: [line(1, 9_999_999_999.99)], tax: 0.01 }],
  ])('refuses a %s outside the Decimal(12,2) range', (field, input) => {
    expect(computeInvoiceAmounts(input)).toEqual({
      ok: false,
      field,
      message: INVOICE_AMOUNT_RANGE_MESSAGE,
    });
  });

  it('accepts the largest representable total', () => {
    expect(amountsOf({ items: [line(1, 9_999_999_999.99)] }).total).toBe(9_999_999_999.99);
    expect(amountsOf({ items: [line(1, 9_999_999_999.99)], discount: 0.01, tax: 0.01 }).total).toBe(
      9_999_999_999.99
    );
  });
});
