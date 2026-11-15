/**
 * #718 — sellable non-drug retail stock.
 *
 * The catalogue already carries `PharmacyProductFamily.FRONT_SHOP` (and tax profiles carry a
 * `FRONT_SHOP` product class). No parallel enum is added: the two commercial classes are derived
 * from that family.
 *
 * - `MEDICINE`: every DRAP-scope family. Keeps DRAP registration, printed MRP, Rx/controlled
 *   checks and FEFO, and can never be promoted.
 * - `NON_DRUG_RETAIL`: `FRONT_SHOP` cosmetics, baby care and FMCG. Carries an EAN-13, a shop-set
 *   retail price, an optional expiry and a retail category, and is the only class a marketing
 *   template may feature.
 */

export const PHARMACY_PRODUCT_CLASSES = ['MEDICINE', 'NON_DRUG_RETAIL'] as const;
export type PharmacyProductClass = (typeof PHARMACY_PRODUCT_CLASSES)[number];

/** Fail closed: anything that is not explicitly FRONT_SHOP is a medicine. */
export function productClassForFamily(family: string | null | undefined): PharmacyProductClass {
  return family === 'FRONT_SHOP' ? 'NON_DRUG_RETAIL' : 'MEDICINE';
}

export function isNonDrugRetail(family: string | null | undefined): boolean {
  return productClassForFamily(family) === 'NON_DRUG_RETAIL';
}

/** GS1 EAN-13: 13 digits with a valid mod-10 check digit. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let index = 0; index < 12; index++) sum += Number(code[index]) * (index % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

export class PharmacyProductClassError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_RETAIL_CATEGORY'
      | 'INVALID_RETAIL_PRICE'
      | 'INVALID_EAN13'
      | 'RETAIL_FIELDS_MEDICINE'
      | 'MEDICINE_NOT_PROMOTABLE'
      | 'PROMOTED_ITEM_NOT_FOUND'
  ) {
    super(reason);
  }
}

/**
 * Retail-only catalogue fields. A medicine never takes a shop-set price, category or retail
 * EAN-13 through this path; a non-drug price must be a positive whole minor-unit amount.
 */
export function validateRetailFields(input: {
  productFamily: string;
  retailPriceMinor?: number | null;
  retailCategory?: string | null;
  ean13?: string | null;
}): { retailPriceMinor: number | null; retailCategory: string | null; ean13: string | null } {
  const price = input.retailPriceMinor ?? null;
  const rawCategory = input.retailCategory ?? null;
  const ean13 = input.ean13 ?? null;
  if (!isNonDrugRetail(input.productFamily)) {
    if (price !== null || rawCategory !== null || ean13 !== null)
      throw new PharmacyProductClassError('RETAIL_FIELDS_MEDICINE');
    return { retailPriceMinor: null, retailCategory: null, ean13: null };
  }
  if (price !== null && (!Number.isSafeInteger(price) || price <= 0))
    throw new PharmacyProductClassError('INVALID_RETAIL_PRICE');
  if (ean13 !== null && !isValidEan13(ean13)) throw new PharmacyProductClassError('INVALID_EAN13');
  let retailCategory: string | null = null;
  if (rawCategory !== null) {
    const value = rawCategory.trim().replace(/\s+/g, ' ');
    if (value.length > 80) throw new PharmacyProductClassError('INVALID_RETAIL_CATEGORY');
    retailCategory = value || null;
  }
  return { retailPriceMinor: price, retailCategory, ean13 };
}

/**
 * Non-drug items need no manufacturer batch and expiry is optional. Stock still flows through the
 * lot ledger, so a missing batch resolves to a deterministic house batch per item and expiry: the
 * counter never asks for a batch, and two deliveries with different expiries never share a batch.
 * A missing expiry is stored as a far-future date no expiry window or FEFO block can reach.
 */
export const NON_DRUG_NO_EXPIRY = new Date('9998-12-31T00:00:00.000Z');

/**
 * QA-3 — whether a stored lot date is the no-expiry marker above, either as the printed date or
 * as the expiry instant derived from it. The marker is storage only: every screen, receipt and
 * export says the item has no expiry instead of printing 9998-12-31 as if it were a real date.
 */
export function isNoExpiryDate(value: Date | string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  const date = value instanceof Date ? value : new Date(value);
  return (
    !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= NON_DRUG_NO_EXPIRY.getUTCFullYear()
  );
}

export const NO_EXPIRY_LABEL = 'No expiry';
export const NON_DRUG_HOUSE_BATCH_PREFIX = 'RETAIL-';

export type ReceiptBatchResolution =
  | { ok: true; batchNumber: string; printedExpiry: Date; expiryPrecision: 'DAY' | 'MONTH' }
  | { ok: false; reason: 'MISSING_BATCH' | 'MISSING_EXPIRY' };

export function resolveReceiptBatchIdentity(input: {
  productFamily: string;
  batchNumber?: string | null;
  printedExpiry?: Date | null;
  expiryPrecision: 'DAY' | 'MONTH';
}): ReceiptBatchResolution {
  const batch = input.batchNumber?.trim() ?? '';
  const expiry =
    input.printedExpiry && !Number.isNaN(input.printedExpiry.getTime())
      ? input.printedExpiry
      : null;
  if (!isNonDrugRetail(input.productFamily)) {
    // Medicines keep PUR-02 exactly: printed batch and printed expiry are mandatory.
    if (!batch) return { ok: false, reason: 'MISSING_BATCH' };
    if (!expiry) return { ok: false, reason: 'MISSING_EXPIRY' };
    return {
      ok: true,
      batchNumber: batch,
      printedExpiry: expiry,
      expiryPrecision: input.expiryPrecision,
    };
  }
  const printedExpiry = expiry ?? NON_DRUG_NO_EXPIRY;
  const expiryPrecision = expiry ? input.expiryPrecision : 'DAY';
  const suffix = expiry
    ? `${expiry.toISOString().slice(0, 10)}-${expiryPrecision === 'MONTH' ? 'M' : 'D'}`
    : 'NOEXP';
  return {
    ok: true,
    batchNumber: batch || `${NON_DRUG_HOUSE_BATCH_PREFIX}${suffix}`,
    printedExpiry,
    expiryPrecision,
  };
}

/**
 * A non-drug lot is priced at the shop-set retail price when the receipt line states none. A
 * medicine lot always needs the printed DRAP MRP from the receipt line.
 */
export function resolveReceiptRetailPrice(input: {
  productFamily: string;
  printedMrpMinor?: number | null;
  retailPriceMinor?: number | null;
}): number | null {
  if (input.printedMrpMinor !== undefined && input.printedMrpMinor !== null)
    return input.printedMrpMinor;
  if (!isNonDrugRetail(input.productFamily)) return null;
  const retail = input.retailPriceMinor ?? null;
  return retail !== null && Number.isSafeInteger(retail) && retail > 0 ? retail : null;
}

export type PromotableProduct = {
  id: string;
  productFamily: string;
  rx: boolean;
  restricted: boolean;
  controlled: boolean;
};

/**
 * Server-side marketing guard layered on the clinical-copy guard: every featured item must be a
 * visible NON_DRUG_RETAIL item with no Rx, restricted or controlled flag. One medicine SKU refuses.
 */
export function assertPromotableProducts(
  requestedIds: readonly string[],
  products: readonly PromotableProduct[]
): void {
  const byId = new Map(products.map((product) => [product.id, product]));
  for (const id of requestedIds) {
    const product = byId.get(id);
    if (!product) throw new PharmacyProductClassError('PROMOTED_ITEM_NOT_FOUND');
    if (
      !isNonDrugRetail(product.productFamily) ||
      product.rx ||
      product.restricted ||
      product.controlled
    )
      throw new PharmacyProductClassError('MEDICINE_NOT_PROMOTABLE');
  }
}

/**
 * Receiving bench: whether one lot slot of an ordered line arrived. A medicine lot arrives only
 * with its printed batch. A non-drug item has no batch, so its first lot arrives with any packs
 * received; further lots still need a batch or an expiry to tell them apart.
 */
export function receivingLotArrived(input: {
  productFamily: string | null | undefined;
  primaryLot: boolean;
  batchNumber: string;
  printedExpiry: string;
  receivedPacks: string;
}): boolean {
  if (input.batchNumber.trim()) return true;
  if (!isNonDrugRetail(input.productFamily)) return false;
  if (input.printedExpiry.trim()) return true;
  const packs = Number(input.receivedPacks.trim() || '0');
  return input.primaryLot && Number.isFinite(packs) && packs > 0;
}
