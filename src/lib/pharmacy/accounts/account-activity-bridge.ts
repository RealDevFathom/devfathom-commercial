export type AccountAggregate = Readonly<{
  accountCode: string;
  currency: string;
  openingMinor: string;
  debitMinor: string;
  creditMinor: string;
  closingMinor: string;
}>;

export type AccountActivityBridge = Readonly<
  AccountAggregate & {
    coverage: 'posted-ledger-coverage-unknown';
  }
>;

export type BridgeOutcome =
  | Readonly<{ status: 'ready'; bridge: AccountActivityBridge }>
  | Readonly<{ status: 'account-not-found' }>
  | Readonly<{ status: 'currency-not-found' }>;

export class AccountActivityBridgeError extends Error {
  constructor(readonly reason: 'INVALID_DTO' | 'DUPLICATE' | 'INCONSISTENT_CLOSING') {
    super(reason);
    this.name = 'AccountActivityBridgeError';
  }
}

const integer = /^-?(?:0|[1-9]\d*)$/;

function validate(row: AccountAggregate) {
  if (
    !row ||
    typeof row.accountCode !== 'string' ||
    !row.accountCode ||
    typeof row.currency !== 'string' ||
    !row.currency ||
    ![row.openingMinor, row.debitMinor, row.creditMinor, row.closingMinor].every(
      (value) => typeof value === 'string' && integer.test(value)
    )
  ) {
    throw new AccountActivityBridgeError('INVALID_DTO');
  }
}

/** Projects one exact account/currency from complete financialStatements account aggregates. */
export function projectAccountActivityBridge(
  rows: readonly AccountAggregate[],
  selection: Readonly<{ accountCode: string; currency: string }>
): BridgeOutcome {
  for (const row of rows) validate(row);
  const accountRows = rows.filter((row) => row.accountCode === selection.accountCode);
  if (!accountRows.length) return Object.freeze({ status: 'account-not-found' as const });
  const matches = accountRows.filter((row) => row.currency === selection.currency);
  if (!matches.length) return Object.freeze({ status: 'currency-not-found' as const });
  if (matches.length !== 1) throw new AccountActivityBridgeError('DUPLICATE');

  const row = matches[0]!;
  const calculated = BigInt(row.openingMinor) + BigInt(row.debitMinor) - BigInt(row.creditMinor);
  if (calculated.toString() !== BigInt(row.closingMinor).toString())
    throw new AccountActivityBridgeError('INCONSISTENT_CLOSING');

  return Object.freeze({
    status: 'ready' as const,
    bridge: Object.freeze({ ...row, coverage: 'posted-ledger-coverage-unknown' as const }),
  });
}

function csvCell(value: string) {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const protectedValue = /^\s*[=+\-@]/.test(withoutControls)
    ? `'${withoutControls}`
    : withoutControls;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

/** Produces deterministic evidence CSV without coercing monetary strings to Number. */
export function accountActivityBridgeCsv(bridge: AccountActivityBridge) {
  const fields = [
    'account_code',
    'currency',
    'opening_minor',
    'debits_minor',
    'credits_minor',
    'closing_minor',
    'coverage',
  ];
  const values = [
    bridge.accountCode,
    bridge.currency,
    bridge.openingMinor,
    bridge.debitMinor,
    bridge.creditMinor,
    bridge.closingMinor,
    bridge.coverage,
  ];
  return `${fields.map(csvCell).join(',')}\r\n${values.map(csvCell).join(',')}\r\n`;
}

/** Validate explicit values before any authorized financial DTO read. */
export function validAccountActivityQuery(
  params: Record<string, string | string[] | undefined>,
  from: string,
  to: string
): boolean {
  for (const key of ['branchId', 'from', 'to', 'accountCode', 'currency']) {
    const value = params[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return false;
  }
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  }
  const duration = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return duration > 0 && duration <= 92 * 86_400_000;
}
