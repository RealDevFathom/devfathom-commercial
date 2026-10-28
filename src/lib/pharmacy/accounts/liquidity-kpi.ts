export const POSTED_CASH_COVERAGE_DEFINITION =
  'Posted CASH plus BANK divided by posted ACCOUNTS_PAYABLE plus GOODS_RECEIVED_ACCRUAL, kept separate by recorded currency.';

const CASH_ACCOUNTS = new Set(['CASH', 'BANK']);
const LIABILITY_ACCOUNTS = new Set(['ACCOUNTS_PAYABLE', 'GOODS_RECEIVED_ACCRUAL']);

export type PostedAccountBalance = Readonly<{
  accountCode: string;
  currency: string;
  closingMinor: string;
}>;

export type CashCoverageFlag = 'NEGATIVE_CASH' | 'DEBIT_LIABILITY';

export type PostedCashCoverage = Readonly<{
  currency: string;
  cashMinor: string;
  bankMinor: string;
  accountsPayableMinor: string;
  goodsReceivedAccrualMinor: string;
  numeratorMinor: string;
  denominatorMinor: string;
  ratio: Readonly<{ numerator: string; denominator: string }> | null;
  status: 'available' | 'unavailable';
  flags: readonly CashCoverageFlag[];
}>;

/** Pure posted-ledger classifier. Inputs are never normalized across currencies or mutated. */
export function postedCashCoverage(
  accounts: readonly PostedAccountBalance[]
): readonly PostedCashCoverage[] {
  const currencies = new Map<
    string,
    { cash: bigint; bank: bigint; payable: bigint; accrual: bigint }
  >();
  for (const account of accounts) {
    if (!CASH_ACCOUNTS.has(account.accountCode) && !LIABILITY_ACCOUNTS.has(account.accountCode))
      continue;
    const current = currencies.get(account.currency) ?? {
      cash: BigInt(0),
      bank: BigInt(0),
      payable: BigInt(0),
      accrual: BigInt(0),
    };
    const closing = BigInt(account.closingMinor);
    if (account.accountCode === 'CASH') current.cash += closing;
    if (account.accountCode === 'BANK') current.bank += closing;
    // The source reader is debit-positive; liabilities are reported credit-positive here.
    if (account.accountCode === 'ACCOUNTS_PAYABLE') current.payable -= closing;
    if (account.accountCode === 'GOODS_RECEIVED_ACCRUAL') current.accrual -= closing;
    currencies.set(account.currency, current);
  }

  return [...currencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => {
      const numerator = value.cash + value.bank;
      const denominator = value.payable + value.accrual;
      const flags: CashCoverageFlag[] = [];
      if (value.cash < BigInt(0) || value.bank < BigInt(0) || numerator < BigInt(0))
        flags.push('NEGATIVE_CASH');
      if (value.payable < BigInt(0) || value.accrual < BigInt(0)) flags.push('DEBIT_LIABILITY');
      return Object.freeze({
        currency,
        cashMinor: value.cash.toString(),
        bankMinor: value.bank.toString(),
        accountsPayableMinor: value.payable.toString(),
        goodsReceivedAccrualMinor: value.accrual.toString(),
        numeratorMinor: numerator.toString(),
        denominatorMinor: denominator.toString(),
        ratio:
          denominator > BigInt(0)
            ? Object.freeze({
                numerator: numerator.toString(),
                denominator: denominator.toString(),
              })
            : null,
        status: denominator > BigInt(0) ? ('available' as const) : ('unavailable' as const),
        flags: Object.freeze(flags),
      });
    });
}

function csvCell(value: string) {
  const safe = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Spreadsheet-safe, exact-integer export. It does not round ratios or modify its rows. */
export function postedCashCoverageCsv(rows: readonly PostedCashCoverage[]) {
  const header = [
    'recorded_currency',
    'cash_minor',
    'bank_minor',
    'accounts_payable_minor_credit_positive',
    'goods_received_accrual_minor_credit_positive',
    'ratio_numerator_minor',
    'ratio_denominator_minor',
    'coverage_ratio_exact',
    'status',
    'flags',
  ];
  const body = rows.map((row) =>
    [
      row.currency,
      row.cashMinor,
      row.bankMinor,
      row.accountsPayableMinor,
      row.goodsReceivedAccrualMinor,
      row.numeratorMinor,
      row.denominatorMinor,
      row.ratio ? `${row.ratio.numerator}/${row.ratio.denominator}` : '',
      row.status,
      row.flags.join('|'),
    ]
      .map(csvCell)
      .join(',')
  );
  return `\uFEFF${[header.map(csvCell).join(','), ...body].join('\r\n')}\r\n`;
}

export function formatCoverageRatio(row: PostedCashCoverage, decimals = 2) {
  if (!row.ratio) return 'Unavailable';
  const numerator = BigInt(row.ratio.numerator);
  const denominator = BigInt(row.ratio.denominator);
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const scale = BigInt(10) ** BigInt(decimals);
  const scaled = (absolute * scale) / denominator;
  return `${negative ? '-' : ''}${scaled / scale}.${String(scaled % scale).padStart(decimals, '0')}×`;
}
