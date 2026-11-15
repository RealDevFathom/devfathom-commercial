import { isPersistableMoney, roundMoney, sumMoney } from './money';

/** Sum the persisted (already rounded) lines, subtract a fixed discount, then add tax. */
export function invoiceTotals(amounts: number[], tax = 0, discount = 0) {
  const subtotal = sumMoney(amounts);
  const roundedTax = roundMoney(tax);
  const roundedDiscount = roundMoney(discount);
  return {
    subtotal,
    tax: roundedTax,
    discount: roundedDiscount,
    total: sumMoney([subtotal, -roundedDiscount, roundedTax]),
  };
}

export function invoiceTotalsError(totals: ReturnType<typeof invoiceTotals>): string | null {
  if (totals.discount > totals.subtotal) return 'Discount cannot exceed the subtotal';
  if (Object.values(totals).some((value) => !isPersistableMoney(value))) {
    return 'Invoice amounts must be between 0 and 9,999,999,999.99';
  }
  return null;
}
