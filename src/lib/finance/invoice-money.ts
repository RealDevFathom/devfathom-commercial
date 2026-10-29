export type InvoiceMoneyLine = {
  description: string;
  quantity: number;
  rate: number;
};

export const roundInvoiceMoney = (value: number) => Math.round(value * 100) / 100;

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
    ...line,
    amount: roundInvoiceMoney(line.quantity * line.rate),
  }));
  const subtotal = roundInvoiceMoney(items.reduce((sum, line) => sum + line.amount, 0));
  const tax = roundInvoiceMoney(taxValue);
  const discount = roundInvoiceMoney(discountValue);

  if (discount > subtotal) {
    throw new RangeError('Discount cannot exceed the invoice subtotal');
  }

  return {
    items,
    subtotal,
    discount,
    tax,
    total: roundInvoiceMoney(subtotal - discount + tax),
  };
}
