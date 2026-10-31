export type InvoiceMoneyItem = { quantity: number; rate: number };

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ''] = mantissa.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - exponent;
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function roundedCents(coefficient: bigint, scale: number): bigint {
  if (scale <= 2) return coefficient * 10n ** BigInt(2 - scale);
  const divisor = 10n ** BigInt(scale - 2);
  const sign = coefficient < 0n ? -1n : 1n;
  const magnitude = coefficient * sign;
  return sign * (magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n));
}

export function moneyCents(value: number): bigint {
  const parts = decimalParts(value);
  return roundedCents(parts.coefficient, parts.scale);
}

export function invoiceLineCents({ quantity, rate }: InvoiceMoneyItem): bigint {
  const quantityParts = decimalParts(quantity);
  const rateParts = decimalParts(rate);
  return roundedCents(
    quantityParts.coefficient * rateParts.coefficient,
    quantityParts.scale + rateParts.scale
  );
}

export const fromCents = (cents: bigint) => Number(cents) / 100;

/** Canonical cent-based preview shared by invoice forms and server persistence. */
export function calculateInvoiceMoney(items: InvoiceMoneyItem[], tax = 0, discount = 0) {
  const amountCents = items.map(invoiceLineCents);
  const subtotalCents = amountCents.reduce((sum, amount) => sum + amount, 0n);
  const discountCents = moneyCents(discount);
  const taxCents = moneyCents(tax);
  const totalCents = subtotalCents - discountCents + taxCents;

  return {
    amountCents,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents,
    amounts: amountCents.map(fromCents),
    subtotal: fromCents(subtotalCents),
    discount: fromCents(discountCents),
    tax: fromCents(taxCents),
    total: fromCents(totalCents),
  };
}
