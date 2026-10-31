export type AccountActivityAggregate = {
  accountCode: unknown;
  currency: unknown;
  openingMinor: unknown;
  debitMinor: unknown;
  creditMinor: unknown;
  closingMinor: unknown;
};

export type AccountActivityBridge = Readonly<{
  accountCode: string;
  currency: string;
  openingMinor: string;
  debitMinor: string;
  creditMinor: string;
  closingMinor: string;
  postedCoverage: 'unknown';
}>;

export class AccountActivityBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountActivityBridgeError';
  }
}

export function assertAccountActivityScope(
  scope: unknown,
  expected: Readonly<{ organizationId: string; branchId: string }>
): void {
  if (
    !scope ||
    typeof scope !== 'object' ||
    !('organizationId' in scope) ||
    !('branchId' in scope) ||
    scope.organizationId !== expected.organizationId ||
    scope.branchId !== expected.branchId
  )
    throw new AccountActivityBridgeError(
      'The aggregate DTO is missing or outside the requested scope.'
    );
}

const integer = /^-?(?:0|[1-9]\d*)$/;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new AccountActivityBridgeError(`${label} is missing.`);
  return value;
}

function requiredInteger(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!integer.test(text))
    throw new AccountActivityBridgeError(`${label} is not an integer minor-unit string.`);
  return text;
}

/**
 * Isolates one account/currency bridge from the financial-statement aggregates.
 * It intentionally never accepts journal rows or invents absent amounts.
 */
export function accountActivityBridge(
  aggregates: readonly AccountActivityAggregate[],
  selection: Readonly<{ accountCode: string; currency: string }>
): AccountActivityBridge {
  const accountCode = requiredText(selection.accountCode, 'Selected account');
  const currency = requiredText(selection.currency, 'Selected currency');
  const matches = aggregates.filter(
    (row) => row.accountCode === accountCode && row.currency === currency
  );
  if (matches.length === 0)
    throw new AccountActivityBridgeError(
      'No aggregate exists for the selected account and currency.'
    );
  if (matches.length !== 1)
    throw new AccountActivityBridgeError(
      'Duplicate aggregates exist for the selected account and currency.'
    );

  const row = matches[0]!;
  const openingMinor = requiredInteger(row.openingMinor, 'Opening');
  const debitMinor = requiredInteger(row.debitMinor, 'Debit');
  const creditMinor = requiredInteger(row.creditMinor, 'Credit');
  const closingMinor = requiredInteger(row.closingMinor, 'Closing');
  if (BigInt(openingMinor) + BigInt(debitMinor) - BigInt(creditMinor) !== BigInt(closingMinor))
    throw new AccountActivityBridgeError('The aggregate closing amount does not reconcile.');

  return Object.freeze({
    accountCode,
    currency,
    openingMinor,
    debitMinor,
    creditMinor,
    closingMinor,
    postedCoverage: 'unknown' as const,
  });
}

function csvCell(value: string): string {
  // Validated minor-unit integers stay numeric; a leading '-' is a sign, not a formula.
  if (integer.test(value)) return `"${value}"`;
  const safe = /^[\s\p{Cc}]*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Spreadsheet-safe evidence containing only the selected recorded-currency aggregate. */
export function accountActivityBridgeCsv(bridge: AccountActivityBridge): string {
  const headings = [
    'accountCode',
    'currency',
    'openingMinor',
    'debitMinor',
    'creditMinor',
    'closingMinor',
    'postedCoverage',
  ];
  const values = [
    bridge.accountCode,
    bridge.currency,
    bridge.openingMinor,
    bridge.debitMinor,
    bridge.creditMinor,
    bridge.closingMinor,
    bridge.postedCoverage,
  ];
  return `${headings.map(csvCell).join(',')}\r\n${values.map(csvCell).join(',')}\r\n`;
}
