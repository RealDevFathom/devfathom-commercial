import { add, formatMoney, sum } from '@/lib/restaurant/money-arithmetic';
import { quoteTaxSettlement, type TaxProfile, type TaxRule } from '@/lib/restaurant/tax-calculator';

export type DraftCheckLine = {
  id: string;
  unitPrice: string;
  quantity: number;
  /** Modifier price deltas, in currency units, already snapshotted on the line. */
  modifierDeltas?: readonly string[];
};

export type DraftCheckTotalInput = {
  lines: readonly DraftCheckLine[];
  serviceCharge?: string;
  deliveryFee?: string;
  profiles?: TaxProfile[];
  rules?: TaxRule[];
  at?: Date;
};

/**
 * The amount a composed check will charge: modifiers, tax, service, and delivery.
 *
 * Merchandise and tax come from `quoteTaxSettlement`. Service is a non-taxable
 * charge on that quote. Delivery is added afterwards, the same way a bill adds
 * `deliveryFeeTotal` onto the taxable grand total. Money stays on the decimal
 * helper, so a third decimal rounds half-up instead of being sliced off.
 */
export function quoteDraftCheckTotal(input: DraftCheckTotalInput): string {
  const at = input.at ?? new Date();
  const fallback = input.profiles ? null : zeroTax(at);
  const quote = quoteTaxSettlement({
    lines: input.lines.map((line) => ({
      id: line.id,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      modifierTotal: formatMoney(sum(line.modifierDeltas ?? [])),
    })),
    profiles: input.profiles ?? fallback!.profiles,
    rules: input.rules ?? fallback!.rules,
    at,
    proposedTenderType: 'CASH',
    serviceCharge: { amount: input.serviceCharge ?? '0.00', taxable: false },
  });
  return formatMoney(add(quote.grandTotal.toString(), input.deliveryFee ?? '0.00'));
}

function zeroTax(at: Date): { profiles: TaxProfile[]; rules: TaxRule[] } {
  const effectiveFrom = new Date(at.getTime() - 86_400_000);
  const effectiveTo = new Date(at.getTime() + 86_400_000);
  const profile: TaxProfile = {
    id: 'draft-zero-tax',
    effectiveFrom,
    effectiveTo,
    status: 'PUBLISHED',
    approvalReference: 'DRAFT-ZERO',
    approvedAt: effectiveFrom,
  };
  const rules = (['CASH', 'CARD', 'OTHER'] as const).map((category): TaxRule => ({
    id: `draft-zero-${category}`,
    profileVersionId: profile.id,
    paymentCategory: category,
    priceMode: 'EXCLUSIVE',
    rate: '0',
    effectiveFrom,
    effectiveTo,
    status: 'PUBLISHED',
    approvalReference: 'DRAFT-ZERO',
    approvedAt: effectiveFrom,
    sourceExpiresAt: effectiveTo,
  }));
  return { profiles: [profile], rules };
}
