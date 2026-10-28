export const LIQUIDITY_KPI_DEFINITION =
  'Posted cash coverage is (CASH + BANK) divided by credit-positive ACCOUNTS_PAYABLE plus GOODS_RECEIVED_ACCRUAL, calculated independently in each recorded currency at the exclusive cutoff.';

const COMPONENTS = ['CASH', 'BANK', 'ACCOUNTS_PAYABLE', 'GOODS_RECEIVED_ACCRUAL'] as const;
type Component = (typeof COMPONENTS)[number];

export type LiquidityAccountAggregate = Readonly<{
  accountCode: string;
  currency: string;
  closingMinor: string;
}>;

export type LiquidityKpiRow = Readonly<{
  currency: string;
  cashMinor: string | null;
  bankMinor: string | null;
  availableFundsMinor: string | null;
  accountsPayableMinor: string | null;
  goodsReceivedAccrualMinor: string | null;
  recordedLiabilitiesMinor: string | null;
  ratio: Readonly<{ numerator: string; denominator: string }> | null;
  flags: readonly string[];
  missingComponents: readonly Component[];
}>;

export type LiquidityKpiReport = Readonly<{
  definition: string;
  rows: readonly LiquidityKpiRow[];
  unknownAccountCodes: readonly string[];
  disclosures: readonly string[];
}>;

function integer(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new TypeError('Account aggregate is not an integer string.');
  return BigInt(value);
}

function gcd(left: bigint, right: bigint) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Pure projection of the already-authorized financialStatements.accounts response. */
export function projectLiquidityKpi(
  accounts: readonly LiquidityAccountAggregate[]
): LiquidityKpiReport {
  const currencies = new Map<string, Map<Component, bigint>>();
  const unknown = new Set<string>();
  for (const account of accounts) {
    if (!account.currency.trim()) throw new TypeError('Recorded currency is required.');
    if (!COMPONENTS.includes(account.accountCode as Component)) {
      unknown.add(account.accountCode);
      continue;
    }
    const code = account.accountCode as Component;
    const components = currencies.get(account.currency) ?? new Map<Component, bigint>();
    components.set(code, (components.get(code) ?? 0n) + integer(account.closingMinor));
    currencies.set(account.currency, components);
  }

  const rows = [...currencies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, values]): LiquidityKpiRow => {
      const missingComponents = COMPONENTS.filter((code) => !values.has(code));
      const cash = values.get('CASH') ?? null;
      const bank = values.get('BANK') ?? null;
      const payable = values.has('ACCOUNTS_PAYABLE') ? -values.get('ACCOUNTS_PAYABLE')! : null;
      const accrual = values.has('GOODS_RECEIVED_ACCRUAL')
        ? -values.get('GOODS_RECEIVED_ACCRUAL')!
        : null;
      const funds = cash !== null && bank !== null ? cash + bank : null;
      const liabilities = payable !== null && accrual !== null ? payable + accrual : null;
      const flags: string[] = [];
      if (funds !== null && funds < 0n) flags.push('Negative posted cash and bank balance');
      if (payable !== null && payable < 0n)
        flags.push('Accounts payable has an unusual debit balance');
      if (accrual !== null && accrual < 0n)
        flags.push('Goods received accrual has an unusual debit balance');
      let ratio: LiquidityKpiRow['ratio'] = null;
      if (funds !== null && liabilities !== null && liabilities > 0n) {
        const divisor = gcd(funds, liabilities);
        ratio = Object.freeze({
          numerator: (funds / divisor).toString(),
          denominator: (liabilities / divisor).toString(),
        });
      }
      return Object.freeze({
        currency,
        cashMinor: cash?.toString() ?? null,
        bankMinor: bank?.toString() ?? null,
        availableFundsMinor: funds?.toString() ?? null,
        accountsPayableMinor: payable?.toString() ?? null,
        goodsReceivedAccrualMinor: accrual?.toString() ?? null,
        recordedLiabilitiesMinor: liabilities?.toString() ?? null,
        ratio,
        flags: Object.freeze(flags),
        missingComponents: Object.freeze(missingComponents),
      });
    });

  return Object.freeze({
    definition: LIQUIDITY_KPI_DEFINITION,
    rows: Object.freeze(rows),
    unknownAccountCodes: Object.freeze([...unknown].sort()),
    disclosures: Object.freeze([
      'Only posted journal aggregates are included; unposted activity and overall posting completeness remain unknown.',
      'No maturity, due-date, liquidity classification, currency conversion, reconciliation, or certified solvency conclusion is available.',
      'A missing component is unknown rather than zero. The ratio is unavailable when either side is incomplete or recorded liabilities are zero or negative.',
    ]),
  });
}

function csvCell(value: string) {
  let safe = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  if (/^[\s\p{M}]*[=+\-@]/u.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function liquidityKpiCsv(report: LiquidityKpiReport): string {
  const header = [
    'record_type',
    'currency',
    'cash_minor',
    'bank_minor',
    'available_funds_minor',
    'accounts_payable_credit_positive_minor',
    'goods_received_accrual_credit_positive_minor',
    'recorded_liabilities_minor',
    'ratio_numerator',
    'ratio_denominator',
    'flags_or_disclosure',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of report.rows) {
    lines.push(
      [
        'evidence',
        row.currency,
        row.cashMinor ?? '',
        row.bankMinor ?? '',
        row.availableFundsMinor ?? '',
        row.accountsPayableMinor ?? '',
        row.goodsReceivedAccrualMinor ?? '',
        row.recordedLiabilitiesMinor ?? '',
        row.ratio?.numerator ?? '',
        row.ratio?.denominator ?? '',
        [
          ...row.flags,
          ...(row.missingComponents.length ? [`Missing: ${row.missingComponents.join('|')}`] : []),
        ].join('; '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  for (const disclosure of report.disclosures)
    lines.push(
      ['disclosure', '', '', '', '', '', '', '', '', '', disclosure].map(csvCell).join(',')
    );
  if (report.unknownAccountCodes.length)
    lines.push(
      [
        'disclosure',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        `Other account codes excluded: ${report.unknownAccountCodes.join('|')}`,
      ]
        .map(csvCell)
        .join(',')
    );
  return `${lines.join('\r\n')}\r\n`;
}
