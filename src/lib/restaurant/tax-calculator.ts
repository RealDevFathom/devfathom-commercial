import { Prisma } from '@/generated/prisma/client';

const Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);
type DecimalInput = Prisma.Decimal | string | number;

export type TaxPriceMode = 'EXCLUSIVE' | 'INCLUSIVE';

export interface TaxRule {
  id: string;
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
  discount?: DecimalInput;
  paymentCategory: string;
}

export interface TaxLineResult {
  id: string;
  net: Prisma.Decimal;
  tax: Prisma.Decimal;
  gross: Prisma.Decimal;
  ruleId: string;
}

export class TaxConfigurationError extends Error {}

function money(value: DecimalInput) {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function resolveTaxRule(rules: TaxRule[], category: string, at: Date): TaxRule {
  const matching = rules.filter(
    (rule) =>
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

export function calculateTax(
  lines: TaxLineInput[],
  rules: TaxRule[],
  at: Date
): { lines: TaxLineResult[]; net: Prisma.Decimal; tax: Prisma.Decimal; gross: Prisma.Decimal } {
  const results = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`Invalid quantity for ${line.id}`);
    }
    const rule = resolveTaxRule(rules, line.paymentCategory, at);
    const rate = new Decimal(rule.rate);
    if (rate.isNegative() || rate.greaterThan(1))
      throw new TaxConfigurationError(`Invalid rate for ${rule.id}`);
    const charged = new Decimal(line.unitPrice)
      .plus(line.modifierTotal ?? ZERO)
      .times(line.quantity)
      .minus(line.discount ?? ZERO);
    if (charged.isNegative()) throw new RangeError(`Discount exceeds charge for ${line.id}`);
    const net = money(rule.priceMode === 'INCLUSIVE' ? charged.div(Decimal.add(1, rate)) : charged);
    const tax = money(rule.priceMode === 'INCLUSIVE' ? charged.minus(net) : net.times(rate));
    const gross = money(net.plus(tax));
    return { id: line.id, net, tax, gross, ruleId: rule.id };
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

export function splitMoney(total: DecimalInput, shares: number[]): Prisma.Decimal[] {
  if (shares.length === 0 || shares.some((share) => !Number.isInteger(share) || share <= 0)) {
    throw new RangeError('Shares must be positive integers');
  }
  const cents = money(total).times(100).toNumber();
  const denominator = shares.reduce((sum, share) => sum + share, 0);
  const raw = shares.map((share, index) => ({ index, value: (cents * share) / denominator }));
  const allocated = raw.map(({ value }) => Math.floor(value));
  let remainder = cents - allocated.reduce((sum, value) => sum + value, 0);
  raw
    .sort((a, b) => (b.value % 1) - (a.value % 1) || a.index - b.index)
    .forEach(({ index }) => {
      if (remainder-- > 0) allocated[index] += 1;
    });
  return allocated.map((value) => new Decimal(value).div(100));
}
