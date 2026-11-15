import { csvCell } from '@/lib/csv';

/**
 * Posted cash-coverage KPI: recorded CASH + BANK closing balances against recorded
 * ACCOUNTS_PAYABLE + GOODS_RECEIVED_ACCRUAL closing balances, kept separate per recorded
 * currency. It is a posted-ledger indicator only: not a solvency, current or quick ratio.
 */
export const LIQUIDITY_KPI_MAX_ROWS = 256;
export const LIQUIDITY_KPI_COVERAGE =
  'Posted branch journal lines only; unposted activity and coverage remain unknown.';

const CASH_CODES = ['CASH', 'BANK'] as const;
const LIABILITY_CODES = ['ACCOUNTS_PAYABLE', 'GOODS_RECEIVED_ACCRUAL'] as const;
const KPI_CODES = new Set<string>([...CASH_CODES, ...LIABILITY_CODES]);
const RATIO_DECIMALS = 4;

export type LiquidityKpiFlag =
  'NEGATIVE_CASH' | 'NEGATIVE_BANK' | 'DEBIT_ACCOUNTS_PAYABLE' | 'DEBIT_GOODS_RECEIVED_ACCRUAL';

export type LiquidityKpiCurrency = {
  currency: string;
  /** Debit-signed recorded closing balances. */
  cashMinor: string;
  bankMinor: string;
  /** Credit-positive recorded closing balances. */
  accountsPayableMinor: string;
  goodsReceivedAccrualMinor: string;
  numeratorMinor: string;
  denominatorMinor: string;
  /** Exact `numerator/denominator` in minor units, or null when unavailable. */
  ratio: string | null;
  /** Ratio truncated toward zero to four decimals, or null when unavailable. */
  ratioDecimal: string | null;
  unavailableReason: 'NO_RECORDED_LIABILITIES' | 'NONPOSITIVE_LIABILITIES' | null;
  flags: LiquidityKpiFlag[];
};

export type LiquidityKpi = {
  currencies: LiquidityKpiCurrency[];
  empty: boolean;
};

export class InvalidLiquidityKpiSourceError extends Error {
  constructor() {
    super('The financial source returned an invalid account balance.');
    this.name = 'InvalidLiquidityKpiSourceError';
  }
}

const INTEGER = /^(?:0|-?[1-9]\d*)$/;
const utf8 = new TextEncoder();
const ZERO = BigInt(0);

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8.encode(value).length <= bytes;
}

function integer(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 128 || !INTEGER.test(value)) {
    throw new InvalidLiquidityKpiSourceError();
  }
  return BigInt(value);
}

/** Truncates numerator/denominator toward zero to a fixed number of decimals. */
export function ratioDecimal(numerator: bigint, denominator: bigint, decimals = RATIO_DECIMALS) {
  if (denominator <= ZERO) throw new RangeError('Ratio denominator must be positive.');
  const negative = numerator < ZERO;
  const absolute = negative ? -numerator : numerator;
  const scale = BigInt(10) ** BigInt(decimals);
  const scaled = (absolute * scale) / denominator;
  const whole = scaled / scale;
  const fraction = String(scaled % scale).padStart(decimals, '0');
  const sign = negative && scaled !== ZERO ? '-' : '';
  return `${sign}${whole}${decimals ? `.${fraction}` : ''}`;
}

/**
 * Validates the full inherited account DTO, then derives coverage per recorded currency
 * from the supplied debit-signed `closingMinor` balances. Currencies are never combined.
 */
export function projectLiquidityKpi(accounts: unknown): LiquidityKpi {
  if (!Array.isArray(accounts) || accounts.length > LIQUIDITY_KPI_MAX_ROWS) {
    throw new InvalidLiquidityKpiSourceError();
  }
  const seen = new Set<string>();
  const balances = new Map<string, Map<string, bigint>>();
  for (const candidate of accounts) {
    if (!candidate || typeof candidate !== 'object') throw new InvalidLiquidityKpiSourceError();
    const row = candidate as Record<string, unknown>;
    if (!boundedText(row.accountCode, 128) || !boundedText(row.currency, 32)) {
      throw new InvalidLiquidityKpiSourceError();
    }
    const key = `${row.accountCode.length}:${row.accountCode}${row.currency}`;
    if (seen.has(key)) throw new InvalidLiquidityKpiSourceError();
    seen.add(key);
    const closing = integer(row.closingMinor);
    if (!KPI_CODES.has(row.accountCode)) continue;
    const currency = balances.get(row.currency) ?? new Map<string, bigint>();
    currency.set(row.accountCode, closing);
    balances.set(row.currency, currency);
  }

  const currencies = [...balances.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([currency, codes]): LiquidityKpiCurrency => {
      const cash = codes.get('CASH') ?? ZERO;
      const bank = codes.get('BANK') ?? ZERO;
      const accountsPayable = -(codes.get('ACCOUNTS_PAYABLE') ?? ZERO);
      const goodsReceivedAccrual = -(codes.get('GOODS_RECEIVED_ACCRUAL') ?? ZERO);
      const numerator = cash + bank;
      const denominator = accountsPayable + goodsReceivedAccrual;
      const hasLiabilities = LIABILITY_CODES.some((code) => codes.has(code));
      const unavailableReason = !hasLiabilities
        ? 'NO_RECORDED_LIABILITIES'
        : denominator <= ZERO
          ? 'NONPOSITIVE_LIABILITIES'
          : null;
      const flags: LiquidityKpiFlag[] = [];
      if (cash < ZERO) flags.push('NEGATIVE_CASH');
      if (bank < ZERO) flags.push('NEGATIVE_BANK');
      if (accountsPayable < ZERO) flags.push('DEBIT_ACCOUNTS_PAYABLE');
      if (goodsReceivedAccrual < ZERO) flags.push('DEBIT_GOODS_RECEIVED_ACCRUAL');
      return {
        currency,
        cashMinor: cash.toString(),
        bankMinor: bank.toString(),
        accountsPayableMinor: accountsPayable.toString(),
        goodsReceivedAccrualMinor: goodsReceivedAccrual.toString(),
        numeratorMinor: numerator.toString(),
        denominatorMinor: denominator.toString(),
        ratio: unavailableReason ? null : `${numerator}/${denominator}`,
        ratioDecimal: unavailableReason ? null : ratioDecimal(numerator, denominator),
        unavailableReason,
        flags,
      };
    });
  return { currencies, empty: currencies.length === 0 };
}

export const LIQUIDITY_KPI_CSV_HEADER = [
  'evidence_scope',
  'branch_id',
  'cutoff_exclusive_utc',
  'retrieved_at_utc',
  'recorded_currency',
  'cash_minor',
  'bank_minor',
  'accounts_payable_minor',
  'goods_received_accrual_minor',
  'numerator_minor',
  'denominator_minor',
  'ratio_exact',
  'ratio_truncated_4dp',
  'status',
  'flags',
] as const;

/** Injection-safe CSV of the computed KPI rows. Reads nothing and mutates nothing. */
export function liquidityKpiCsv(
  kpi: LiquidityKpi,
  meta: { branchId: string; cutoff: string; retrievedAt: string }
): string {
  return [
    [...LIQUIDITY_KPI_CSV_HEADER],
    ...kpi.currencies.map((row) => [
      LIQUIDITY_KPI_COVERAGE,
      meta.branchId,
      meta.cutoff,
      meta.retrievedAt,
      row.currency,
      row.cashMinor,
      row.bankMinor,
      row.accountsPayableMinor,
      row.goodsReceivedAccrualMinor,
      row.numeratorMinor,
      row.denominatorMinor,
      row.ratio ?? '',
      row.ratioDecimal ?? '',
      row.unavailableReason ?? 'AVAILABLE',
      row.flags.join(' '),
    ]),
  ]
    .map((line) => line.map(csvCell).join(','))
    .join('\r\n');
}
