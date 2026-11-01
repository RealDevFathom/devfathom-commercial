// Reuse the money core's Decimal so every monetary value shares one class
// identity (instanceof, static Decimal.sum/min). Importing from the money
// helper keeps the Prisma-internal runtime path in a single place instead of
// hard-coding '@prisma/client/runtime/index-browser.js' here, where a Prisma
// upgrade would silently break it.
import { Decimal } from '@/lib/restaurant/money-arithmetic';

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
type DecimalInput = Decimal | string;

export const PAYMENT_CATEGORIES = ['CASH', 'CARD', 'OTHER'] as const;
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];
export type RestaurantTenderType = PaymentCategory;
export type TaxPriceMode = 'EXCLUSIVE' | 'INCLUSIVE';

export interface TaxProfile {
  id: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  approvalReference?: string | null;
  approvedAt?: Date | null;
}

export interface TaxRule {
  id: string;
  profileVersionId: string;
  paymentCategory: string;
  priceMode: TaxPriceMode;
  rate: DecimalInput;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  approvalReference?: string | null;
  approvedAt?: Date | null;
  sourceExpiresAt?: Date | null;
}

export interface TaxLineInput {
  id: string;
  unitPrice: DecimalInput;
  quantity: number;
  modifierTotal?: DecimalInput;
  comp?: DecimalInput;
  beforeTaxDiscount?: DecimalInput;
}

export interface TaxBucketResult {
  category: PaymentCategory;
  consideration: Decimal;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  ruleId: string;
}

export interface TaxLineResult {
  id: string;
  consideration: Decimal;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  buckets: TaxBucketResult[];
}

export interface PriorTender {
  tenderType: RestaurantTenderType;
  principal: DecimalInput;
}

export type ServiceCharge =
  | { amount: DecimalInput; taxable: false }
  | { amount: DecimalInput; taxable: true; tenderType: RestaurantTenderType };

export interface TaxQuoteInput {
  lines: TaxLineInput[];
  profiles: TaxProfile[];
  rules: TaxRule[];
  at: Date;
  proposedTenderType: RestaurantTenderType;
  priorTenderWeights?: PriorTender[];
  acceptedPrincipal?: DecimalInput;
  afterTaxDiscount?: DecimalInput;
  serviceCharge?: ServiceCharge;
  roundingAdjustment?: DecimalInput;
}

export interface TaxQuoteResult {
  proposedCategory: PaymentCategory;
  weights: Record<PaymentCategory, Decimal>;
  lines: TaxLineResult[];
  serviceCharge: TaxBucketResult | null;
  net: Decimal;
  tax: Decimal;
  merchandisePayable: Decimal;
  afterTaxDiscount: Decimal;
  serviceChargePayable: Decimal;
  roundingAdjustment: Decimal;
  grandTotal: Decimal;
  acceptedPrincipal: Decimal;
  remainingDue: Decimal;
}

export class TaxConfigurationError extends Error {}
export class TaxProfileResolutionError extends TaxConfigurationError {
  readonly code: 'TAX_PROFILE_UNAVAILABLE' | 'TAX_RULE_CONFLICT';

  constructor(
    readonly reason: 'MISSING' | 'EXPIRED' | 'AMBIGUOUS',
    message: string
  ) {
    super(message);
    this.code = reason === 'AMBIGUOUS' ? 'TAX_RULE_CONFLICT' : 'TAX_PROFILE_UNAVAILABLE';
  }
}
export class TaxPaymentCategoryError extends TaxConfigurationError {
  readonly code = 'TAX_PAYMENT_CATEGORY_UNSUPPORTED';
}

export function resolveTaxProfile(profiles: TaxProfile[], at: Date): TaxProfile {
  const matching = profiles.filter(
    (profile) => profile.effectiveFrom <= at && (!profile.effectiveTo || at < profile.effectiveTo)
  );
  if (matching.length > 1)
    throw new TaxProfileResolutionError('AMBIGUOUS', 'Ambiguous effective tax profiles');
  if (matching.length === 0) {
    const expired = profiles.some((profile) => profile.effectiveTo && profile.effectiveTo <= at);
    throw new TaxProfileResolutionError(
      expired ? 'EXPIRED' : 'MISSING',
      expired ? 'Effective tax profile expired' : 'Effective tax profile missing'
    );
  }
  const profile = matching[0];
  if (profile.status !== 'PUBLISHED' || !profile.approvalReference || !profile.approvedAt) {
    throw new TaxConfigurationError(`Tax profile ${profile.id} is not approved and current`);
  }
  return profile;
}

function decimal(value: DecimalInput, label: string) {
  if (typeof value === 'number') throw new RangeError(`${label} must use exact decimal input`);
  const result = new Decimal(value);
  if (!result.isFinite()) throw new RangeError(`${label} must be finite`);
  return result;
}

function money(value: DecimalInput, label = 'Money') {
  return decimal(value, label).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Jurisdiction- and vertical-neutral exact tax primitive. Restaurant checkout
 * and pharmacy product-class rules share this inclusive/exclusive and rounding
 * behavior through `@/lib/tax/calculator`.
 */
export function calculateTaxAmount(input: {
  consideration: DecimalInput;
  rate: DecimalInput;
  priceMode: TaxPriceMode;
  roundingScale?: number;
}) {
  const scale = input.roundingScale ?? 2;
  if (!Number.isInteger(scale) || scale < 0 || scale > 4)
    throw new TaxConfigurationError('Tax rounding scale must be between 0 and 4');
  const amount = decimal(input.consideration, 'Consideration').toDecimalPlaces(
    scale,
    Decimal.ROUND_HALF_UP
  );
  const rate = decimal(input.rate, 'Rate');
  if (amount.isNegative()) throw new RangeError('Consideration cannot be negative');
  if (rate.isNegative() || rate.greaterThan(1))
    throw new TaxConfigurationError('Tax rate must be between zero and one');
  const net =
    input.priceMode === 'INCLUSIVE'
      ? amount.div(Decimal.add(1, rate)).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
      : amount;
  const tax =
    input.priceMode === 'INCLUSIVE'
      ? amount.minus(net)
      : amount.times(rate).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  return { net, tax, gross: input.priceMode === 'INCLUSIVE' ? amount : amount.plus(tax) };
}

function cents(value: DecimalInput, label = 'Money') {
  const rounded = money(value, label);
  if (rounded.isNegative()) throw new RangeError('Money cannot be negative');
  return rounded.times(HUNDRED);
}

export function mapTenderTypeToPaymentCategory(tenderType: unknown): PaymentCategory {
  if (
    typeof tenderType === 'string' &&
    PAYMENT_CATEGORIES.includes(tenderType as PaymentCategory)
  ) {
    return tenderType as PaymentCategory;
  }
  throw new TaxPaymentCategoryError(`Unsupported tender type: ${String(tenderType)}`);
}

export function resolveTaxRule(
  rules: TaxRule[],
  profileVersionId: string,
  category: PaymentCategory,
  at: Date
): TaxRule {
  const matching = rules.filter(
    (rule) =>
      rule.profileVersionId === profileVersionId &&
      rule.paymentCategory === category &&
      rule.effectiveFrom <= at &&
      (!rule.effectiveTo || at < rule.effectiveTo)
  );
  if (matching.length !== 1) {
    throw new TaxConfigurationError(
      matching.length === 0
        ? `No effective tax rule for ${category}`
        : `Conflicting tax rules for ${category}`
    );
  }
  const rule = matching[0];
  if (
    rule.status !== 'PUBLISHED' ||
    !rule.approvalReference ||
    !rule.approvedAt ||
    (rule.sourceExpiresAt && rule.sourceExpiresAt <= at)
  ) {
    throw new TaxConfigurationError(`Tax rule ${rule.id} is not approved and current`);
  }
  return rule;
}

function lineConsideration(line: TaxLineInput) {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0)
    throw new RangeError(`Invalid quantity for ${line.id}`);
  if (Object.prototype.hasOwnProperty.call(line, 'paymentCategory'))
    throw new TaxPaymentCategoryError('Raw paymentCategory input is forbidden');
  const unitPrice = decimal(line.unitPrice, `Unit price for ${line.id}`);
  const modifierTotal = decimal(line.modifierTotal ?? ZERO, `Modifier total for ${line.id}`);
  const comp = decimal(line.comp ?? ZERO, `Comp for ${line.id}`);
  const beforeTaxDiscount = decimal(
    line.beforeTaxDiscount ?? ZERO,
    `Before-tax discount for ${line.id}`
  );
  if (unitPrice.isNegative() || comp.isNegative() || beforeTaxDiscount.isNegative())
    throw new RangeError(`Negative charge or reduction for ${line.id}`);
  const value = unitPrice
    .plus(modifierTotal)
    .times(line.quantity)
    .minus(comp)
    .minus(beforeTaxDiscount);
  if (value.isNegative()) throw new RangeError(`Reductions exceed charge for ${line.id}`);
  return money(value);
}

function calculateBucket(
  consideration: DecimalInput,
  category: PaymentCategory,
  profileVersionId: string,
  rules: TaxRule[],
  at: Date
): TaxBucketResult {
  const rule = resolveTaxRule(rules, profileVersionId, category, at);
  const amount = money(consideration);
  const { net, tax, gross } = calculateTaxAmount({
    consideration: amount,
    rate: rule.rate,
    priceMode: rule.priceMode,
  });
  return { category, consideration: amount, net, tax, gross, ruleId: rule.id };
}

export function calculateTax(
  lines: TaxLineInput[],
  profiles: TaxProfile[],
  rules: TaxRule[],
  at: Date,
  tenderType: RestaurantTenderType
): { lines: TaxLineResult[]; net: Decimal; tax: Decimal; gross: Decimal } {
  const category = mapTenderTypeToPaymentCategory(tenderType);
  const profile = resolveTaxProfile(profiles, at);
  const results = lines.map((line) => {
    const consideration = lineConsideration(line);
    const bucket = calculateBucket(consideration, category, profile.id, rules, at);
    return {
      id: line.id,
      consideration,
      net: bucket.net,
      tax: bucket.tax,
      gross: bucket.gross,
      buckets: [bucket],
    };
  });
  return results.reduce(
    (total, line) => ({
      lines: [...total.lines, line],
      net: total.net.plus(line.net),
      tax: total.tax.plus(line.tax),
      gross: total.gross.plus(line.gross),
    }),
    { lines: [] as TaxLineResult[], net: ZERO, tax: ZERO, gross: ZERO }
  );
}

export function splitMoney(total: DecimalInput, shares: DecimalInput[]): Decimal[] {
  const exactShares = shares.map((share) => decimal(share, 'Share'));
  if (exactShares.length === 0 || exactShares.some((share) => !share.isPositive()))
    throw new RangeError('Shares must be positive');
  const totalCents = cents(total);
  const denominator = Decimal.sum(...exactShares);
  const raw = exactShares.map((share, index) => ({
    index,
    value: totalCents.times(share).div(denominator),
  }));
  const allocated = raw.map(({ value }) => value.floor());
  const remainder = totalCents.minus(Decimal.sum(...allocated)).toNumber();
  raw
    .sort(
      (a, b) =>
        b.value.minus(b.value.floor()).comparedTo(a.value.minus(a.value.floor())) ||
        a.index - b.index
    )
    .slice(0, remainder)
    .forEach(({ index }) => {
      allocated[index] = allocated[index].plus(1);
    });
  return allocated.map((value) => value.div(HUNDRED));
}

/** Fractional-bill allocation uses the same largest-remainder rule, with a stable
 * last-fraction tie break so the final sibling absorbs an otherwise equal remainder. */
export function splitFractionalMoney(total: DecimalInput, shares: DecimalInput[]): Decimal[] {
  const exactShares = shares.map((share) => decimal(share, 'Fraction'));
  if (exactShares.length === 0 || exactShares.some((share) => !share.isPositive()))
    throw new RangeError('Fractions must be positive');
  const totalCents = cents(total);
  const denominator = Decimal.sum(ZERO, ...exactShares);
  const raw = exactShares.map((share, index) => ({
    index,
    value: totalCents.times(share).div(denominator),
  }));
  const allocated = raw.map(({ value }) => value.floor());
  const remainder = totalCents.minus(Decimal.sum(ZERO, ...allocated)).toNumber();
  raw
    .sort(
      (a, b) =>
        b.value.minus(b.value.floor()).comparedTo(a.value.minus(a.value.floor())) ||
        b.index - a.index
    )
    .slice(0, remainder)
    .forEach(({ index }) => {
      allocated[index] = allocated[index].plus(1);
    });
  return allocated.map((value) => value.div(HUNDRED));
}

function zeroWeights(): Record<PaymentCategory, Decimal> {
  return { CASH: new Decimal(0), CARD: new Decimal(0), OTHER: new Decimal(0) };
}

export function quoteTaxSettlement(input: TaxQuoteInput): TaxQuoteResult {
  const proposedCategory = mapTenderTypeToPaymentCategory(input.proposedTenderType);
  const profile = resolveTaxProfile(input.profiles, input.at);
  const considerations = input.lines.map(lineConsideration);
  const merchandiseCents = Decimal.sum(ZERO, ...considerations.map((value) => cents(value)));
  const weights = zeroWeights();
  let unallocated = merchandiseCents;
  for (const tender of input.priorTenderWeights ?? []) {
    const category = mapTenderTypeToPaymentCategory(tender.tenderType);
    const principalCents = cents(tender.principal, 'Prior tender principal');
    const weight = Decimal.min(principalCents, unallocated);
    weights[category] = weights[category].plus(weight);
    unallocated = unallocated.minus(weight);
  }
  weights[proposedCategory] = weights[proposedCategory].plus(unallocated);

  const used = PAYMENT_CATEGORIES.filter((category) => weights[category].greaterThan(0));
  const lines = input.lines.map((line, lineIndex) => {
    const consideration = considerations[lineIndex];
    const allocations = used.length
      ? splitMoney(
          consideration,
          used.map((category) => weights[category])
        )
      : [];
    const buckets = used.map((category, index) =>
      calculateBucket(allocations[index], category, profile.id, input.rules, input.at)
    );
    return {
      id: line.id,
      consideration,
      net: Decimal.sum(ZERO, ...buckets.map((bucket) => bucket.net)),
      tax: Decimal.sum(ZERO, ...buckets.map((bucket) => bucket.tax)),
      gross: Decimal.sum(ZERO, ...buckets.map((bucket) => bucket.gross)),
      buckets,
    };
  });
  const service = input.serviceCharge;
  const serviceCharge = service?.taxable
    ? calculateBucket(
        service.amount,
        mapTenderTypeToPaymentCategory(service.tenderType),
        profile.id,
        input.rules,
        input.at
      )
    : null;
  const serviceChargePayable =
    serviceCharge?.gross ?? money(service?.amount ?? ZERO, 'Service charge');
  if (serviceChargePayable.isNegative()) throw new RangeError('Service charge cannot be negative');
  const net = Decimal.sum(ZERO, ...lines.map((line) => line.net), serviceCharge?.net ?? ZERO);
  const tax = Decimal.sum(ZERO, ...lines.map((line) => line.tax), serviceCharge?.tax ?? ZERO);
  const merchandisePayable = Decimal.sum(ZERO, ...lines.map((line) => line.gross));
  const afterTaxDiscount = money(input.afterTaxDiscount ?? ZERO, 'After-tax discount');
  if (afterTaxDiscount.isNegative()) throw new RangeError('After-tax discount cannot be negative');
  if (afterTaxDiscount.greaterThan(merchandisePayable))
    throw new RangeError('After-tax discount exceeds merchandise payable');
  const roundingAdjustment = money(input.roundingAdjustment ?? ZERO, 'Rounding adjustment');
  const acceptedPrincipal = money(input.acceptedPrincipal ?? ZERO, 'Accepted principal');
  if (acceptedPrincipal.isNegative()) throw new RangeError('Accepted principal cannot be negative');
  const grandTotal = merchandisePayable
    .minus(afterTaxDiscount)
    .plus(serviceChargePayable)
    .plus(roundingAdjustment);
  if (grandTotal.isNegative()) throw new RangeError('Discounts exceed payable');
  return {
    proposedCategory,
    weights: {
      CASH: weights.CASH.div(HUNDRED),
      CARD: weights.CARD.div(HUNDRED),
      OTHER: weights.OTHER.div(HUNDRED),
    },
    lines,
    serviceCharge,
    net,
    tax,
    merchandisePayable,
    afterTaxDiscount,
    serviceChargePayable,
    roundingAdjustment,
    grandTotal,
    acceptedPrincipal,
    remainingDue: grandTotal.minus(acceptedPrincipal),
  };
}
