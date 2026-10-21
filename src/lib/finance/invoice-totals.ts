export type InvoiceCalculationItem = {
  quantity: number;
  rate: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Calculate persisted invoice totals in the order subtotal - discount + tax. */
export function calculateInvoiceTotals(
  items: InvoiceCalculationItem[],
  tax = 0,
  discount = 0
) {
  const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.rate, 0));
  const roundedTax = round2(tax);
  const roundedDiscount = round2(discount);

  if (roundedDiscount > subtotal) {
    throw new RangeError('Discount cannot exceed the subtotal');
  }

  return {
    subtotal,
    tax: roundedTax,
    discount: roundedDiscount,
    total: round2(subtotal - roundedDiscount + roundedTax),
  };
}
