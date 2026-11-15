/**
 * DEV-27 (§10 Compliant Messaging 2): vouchers apply to non-drug goods only.
 *
 * Every saleable product falls into exactly one voucher category. A voucher
 * carries an eligible-category allowlist that defaults to non-drug goods, and
 * the drug categories (Rx, OTC drug, supplement, medical device) can never be
 * allowlisted: the POS refuses a voucher on those lines on the server.
 */

export const VOUCHER_DRUG_CATEGORIES = ['RX', 'OTC_DRUG', 'SUPPLEMENT', 'MEDICAL_DEVICE'] as const;
export const VOUCHER_NON_DRUG_CATEGORIES = ['NON_DRUG'] as const;

export type VoucherDrugCategory = (typeof VOUCHER_DRUG_CATEGORIES)[number];
export type VoucherNonDrugCategory = (typeof VOUCHER_NON_DRUG_CATEGORIES)[number];
export type VoucherCategory = VoucherDrugCategory | VoucherNonDrugCategory;

/** Allowlist a voucher gets when none is configured. */
export const DEFAULT_VOUCHER_ELIGIBLE_CATEGORIES: readonly VoucherNonDrugCategory[] = [
  ...VOUCHER_NON_DRUG_CATEGORIES,
];

/** Required footer, auto-added to every voucher message. */
export const VOUCHER_MESSAGE_FOOTER = 'Medicines excluded / Adviyaat shamil nahin';

export type VoucherProductFacts = {
  rx: boolean;
  otc: boolean;
  restricted: boolean;
  controlled: boolean;
  productFamily: 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP' | string;
};

/** Classifies a product; anything not plainly front-shop goods counts as a drug line. */
export function voucherCategoryFor(product: VoucherProductFacts): VoucherCategory {
  if (product.rx || product.restricted || product.controlled) return 'RX';
  if (product.productFamily === 'DEVICE') return 'MEDICAL_DEVICE';
  if (product.productFamily === 'ALTERNATIVE') return 'SUPPLEMENT';
  if (product.otc || product.productFamily !== 'FRONT_SHOP') return 'OTC_DRUG';
  return 'NON_DRUG';
}

export class VoucherScopeError extends Error {
  constructor(
    readonly reason: 'VOUCHER_CATEGORY_REFUSED' | 'VOUCHER_ALLOWLIST_INVALID',
    readonly category?: VoucherCategory
  ) {
    super(reason);
  }
}

/**
 * Normalises a configured allowlist. An empty or missing list falls back to the
 * non-drug default; a list naming a drug category is refused outright.
 */
export function voucherEligibleCategories(
  configured?: readonly string[] | null
): readonly VoucherNonDrugCategory[] {
  if (!configured || configured.length === 0) return DEFAULT_VOUCHER_ELIGIBLE_CATEGORIES;
  const allowed = new Set<string>(VOUCHER_NON_DRUG_CATEGORIES);
  if (!configured.every((category) => allowed.has(category)))
    throw new VoucherScopeError('VOUCHER_ALLOWLIST_INVALID');
  return [...new Set(configured)] as VoucherNonDrugCategory[];
}

/** Server-side gate: throws when a voucher may not apply to this product line. */
export function assertVoucherEligibleLine(
  product: VoucherProductFacts,
  configured?: readonly string[] | null
): void {
  const category = voucherCategoryFor(product);
  const eligible = voucherEligibleCategories(configured) as readonly string[];
  if (!eligible.includes(category))
    throw new VoucherScopeError('VOUCHER_CATEGORY_REFUSED', category);
}

/** Appends the required footer to voucher copy exactly once. */
export function withVoucherFooter(text: string): string {
  const body = text.trimEnd();
  if (body.endsWith(VOUCHER_MESSAGE_FOOTER)) return body;
  return `${body}\n${VOUCHER_MESSAGE_FOOTER}`;
}
