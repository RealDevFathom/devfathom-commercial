import { add, formatMoney, sum } from '@/lib/restaurant/money-arithmetic';
import { serviceChargeBasis, serviceChargeFor } from '@/lib/restaurant/service-charge';
import {
  quoteTaxSettlement,
  type PaymentCategory,
  type TaxProfile,
  type TaxRule,
} from '@/lib/restaurant/tax-calculator';

/**
 * The tender a draft check is quoted under. The preview can only pick one rate,
 * and it picks CASH; a CARD payment may be taxed at a different rate, so the
 * check UI must label the quote as the cash rate (see `DraftCheckBreakdown.tenderType`).
 */
export const DRAFT_CHECK_TENDER_TYPE: PaymentCategory = 'CASH';

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
  /** The tender the quote was priced under — always CASH. A CARD payment may be
   * taxed at a different rate, so the check UI must label this as the cash rate. */
  tenderType: PaymentCategory;
};

/** No published profile is in effect, so the check cannot be priced. */
export class DraftCheckTaxError extends Error {
  readonly code = 'TAX_PROFILE_UNAVAILABLE' as const;

  constructor(message = 'No tax profile is in effect.') {
    super(message);
    this.name = 'DraftCheckTaxError';
  }
}

/** Tax, service, and the amount due. A stored or client total is not an input. */
export function quoteDraftCheckBreakdown(input: DraftCheckTotalInput): DraftCheckBreakdown {
  if (!input.profiles?.length) throw new DraftCheckTaxError();
  const at = input.at ?? new Date();
  const lines = input.lines.map((line) => ({
    id: line.id,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    modifierTotal: formatMoney(sum(line.modifierDeltas ?? [])),
  }));
  const basis = serviceChargeBasis(
    lines.map((line) => ({
      unitCharge: add(line.unitPrice, line.modifierTotal),
      quantity: line.quantity,
    }))
  );
  const serviceAmount =
    input.serviceChargeRate != null
      ? formatMoney(serviceChargeFor(basis, input.serviceChargeRate))
      : (input.serviceCharge ?? '0.00');
  const quote = quoteTaxSettlement({
    lines,
    profiles: input.profiles,
    rules: input.rules ?? [],
    at,
    proposedTenderType: DRAFT_CHECK_TENDER_TYPE,
    serviceCharge: { amount: serviceAmount, taxable: false },
  });
  return {
    tax: formatMoney(quote.tax.toString()),
    serviceCharge: formatMoney(quote.serviceChargePayable.toString()),
    total: formatMoney(add(quote.grandTotal.toString(), input.deliveryFee ?? '0.00')),
    tenderType: DRAFT_CHECK_TENDER_TYPE,
  };
}

export function quoteDraftCheckTotal(input: DraftCheckTotalInput): string {
  return quoteDraftCheckBreakdown(input).total;
}
