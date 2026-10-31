import { isPersistableMoney, multiplyMoney, roundMoney, sumMoney } from './money';

export type InvoiceMoneyLine = {
  description: string;
  quantity: number;
  rate: number;
};

export const roundInvoiceMoney = roundMoney;

/**
 * Applies one money contract to every invoice entry point. Line amounts are
 * rounded first and the subtotal is the sum of those persisted amounts, which
 * prevents the displayed lines and stored subtotal from differing by a cent.
 */
export function calculateInvoiceMoney(
  sourceLines: InvoiceMoneyLine[],
  taxValue = 0,
  discountValue = 0
) {
  const items = sourceLines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    rate: line.rate,
    amount: multiplyMoney(line.quantity, line.rate),
  }));
  const subtotal = sumMoney(items.map((line) => line.amount));
  const tax = roundInvoiceMoney(taxValue);
  const discount = roundInvoiceMoney(discountValue);

  if (discount > subtotal) {
    throw new RangeError('Discount cannot exceed the invoice subtotal');
  }

  const total = sumMoney([subtotal, -discount, tax]);
  if (
    items.some((item) => !isPersistableMoney(item.amount)) ||
    !isPersistableMoney(subtotal) ||
    !isPersistableMoney(tax) ||
    !isPersistableMoney(discount) ||
    !isPersistableMoney(total)
  ) {
    throw new RangeError('Derived invoice amount exceeds the allowed range');
  }

  return {
    items,
    subtotal,
    discount,
    tax,
    total,
  };
}
