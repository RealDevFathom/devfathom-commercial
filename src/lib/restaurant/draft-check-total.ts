import { add, formatMoney, multiply, roundMoney, sum } from '@/lib/restaurant/money-arithmetic';
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
  /** Flat service amount. Ignored when `serviceChargeRate` is set. */
  serviceCharge?: string;
  /** Branch policy rate, such as `0.10`. `0` is an explicit zero, not a missing policy. */
  serviceChargeRate?: string | null;
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
export type DraftCheckBreakdown = {
  tax: string;
  serviceCharge: string;
  total: string;
};

/** Tax, service, and the amount due. A stored or client total is not an input. */
export function quoteDraftCheckBreakdown(input: DraftCheckTotalInput): DraftCheckBreakdown {
  const at = input.at ?? new Date();
  const fallback = input.profiles ? null : zeroTax(at);
  // Settlement rounds per physical unit. Drafts use one CASH rule without
  // per-unit reductions, so quote each unit once and multiply the rounded
  // amounts below. Work and allocation must not grow with the quantity.
  const lines = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`Invalid quantity for ${line.id}`);
    }
    const modifierTotal = formatMoney(sum(line.modifierDeltas ?? []));
    return {
      id: line.id,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      modifierTotal,
    };
  });
  const basis = sum(
    lines.map((line) => multiply(add(line.unitPrice, line.modifierTotal), line.quantity))
  );
  const serviceAmount =
    input.serviceChargeRate != null
      ? formatMoney(roundMoney(multiply(basis, input.serviceChargeRate)))
      : (input.serviceCharge ?? '0.00');
  const quote = quoteTaxSettlement({
    lines: lines.map((line) => ({ ...line, quantity: 1 })),
    profiles: input.profiles ?? fallback!.profiles,
    rules: input.rules ?? fallback!.rules,
    at,
    proposedTenderType: 'CASH',
    serviceCharge: { amount: serviceAmount, taxable: false },
  });
  const tax = sum(quote.lines.map((line, index) => multiply(line.tax, lines[index]!.quantity)));
  const merchandisePayable = sum(
    quote.lines.map((line, index) => multiply(line.gross, lines[index]!.quantity))
  );
  return {
    tax: formatMoney(tax),
    serviceCharge: formatMoney(quote.serviceChargePayable.toString()),
    total: formatMoney(
      sum([merchandisePayable, quote.serviceChargePayable, input.deliveryFee ?? '0.00'])
    ),
  };
}

export function quoteDraftCheckTotal(input: DraftCheckTotalInput): string {
  return quoteDraftCheckBreakdown(input).total;
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
