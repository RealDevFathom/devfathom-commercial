export const TRIAL_BALANCE_MAX_ROWS = 256;

export type TrialBalanceAccount = {
  accountCode: string;
  currency: string;
  openingMinor: string;
  debitMinor: string;
  creditMinor: string;
  closingMinor: string;
};

export type TrialBalanceCurrencyControl = {
  currency: string;
  openingDebit: bigint;
  openingCredit: bigint;
  openingDifference: bigint;
  movementDebit: bigint;
  movementCredit: bigint;
  movementDifference: bigint;
  closingDebit: bigint;
  closingCredit: bigint;
  closingDifference: bigint;
  bridgeDifference: bigint;
};

export type TrialBalanceControl = {
  rows: ReadonlyArray<
    TrialBalanceAccount & {
      opening: bigint;
      debit: bigint;
      credit: bigint;
      closing: bigint;
      rowDifference: bigint;
    }
  >;
  currencies: ReadonlyArray<TrialBalanceCurrencyControl>;
  empty: boolean;
  allZero: boolean;
  inconsistent: boolean;
};

export class InvalidTrialBalanceError extends Error {
  constructor() {
    super('The financial source returned an invalid trial balance.');
    this.name = 'InvalidTrialBalanceError';
  }
}

const integer = /^(?:0|-?[1-9]\d*)$/;
const utf8 = new TextEncoder();

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8.encode(value).length <= bytes;
}

function decimal(value: unknown, nonnegative = false): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !integer.test(value) ||
    (nonnegative && value.startsWith('-'))
  ) {
    throw new InvalidTrialBalanceError();
  }
  return BigInt(value);
}

/**
 * Validates the complete inherited account DTO before producing any totals.
 * Supplied closings remain authoritative: discrepancies are exposed, never repaired.
 */
export function projectTrialBalanceControl(accounts: unknown): TrialBalanceControl {
  if (!Array.isArray(accounts) || accounts.length > TRIAL_BALANCE_MAX_ROWS) {
    throw new InvalidTrialBalanceError();
  }

  const seen = new Set<string>();
  const rows: TrialBalanceControl['rows'][number][] = accounts.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new InvalidTrialBalanceError();
    const row = candidate as Record<string, unknown>;
    if (!boundedText(row.accountCode, 128) || !boundedText(row.currency, 32)) {
      throw new InvalidTrialBalanceError();
    }
    const key = `${row.accountCode.length}:${row.accountCode}${row.currency}`;
    if (seen.has(key)) throw new InvalidTrialBalanceError();
    seen.add(key);

    const opening = decimal(row.openingMinor);
    const debit = decimal(row.debitMinor, true);
    const credit = decimal(row.creditMinor, true);
    const closing = decimal(row.closingMinor);
    return {
      accountCode: row.accountCode,
      currency: row.currency,
      openingMinor: row.openingMinor as string,
      debitMinor: row.debitMinor as string,
      creditMinor: row.creditMinor as string,
      closingMinor: row.closingMinor as string,
      opening,
      debit,
      credit,
      closing,
      rowDifference: closing - (opening + debit - credit),
    };
  });

  const controls = new Map<
    string,
    Omit<TrialBalanceCurrencyControl, 'currency' | 'bridgeDifference'>
  >();
  for (const row of rows) {
    const current = controls.get(row.currency) ?? {
      openingDebit: BigInt(0),
      openingCredit: BigInt(0),
      openingDifference: BigInt(0),
      movementDebit: BigInt(0),
      movementCredit: BigInt(0),
      movementDifference: BigInt(0),
      closingDebit: BigInt(0),
      closingCredit: BigInt(0),
      closingDifference: BigInt(0),
    };
    if (row.opening >= BigInt(0)) current.openingDebit += row.opening;
    else current.openingCredit += -row.opening;
    current.movementDebit += row.debit;
    current.movementCredit += row.credit;
    if (row.closing >= BigInt(0)) current.closingDebit += row.closing;
    else current.closingCredit += -row.closing;
    current.openingDifference = current.openingDebit - current.openingCredit;
    current.movementDifference = current.movementDebit - current.movementCredit;
    current.closingDifference = current.closingDebit - current.closingCredit;
    controls.set(row.currency, current);
  }

  const currencies = [...controls.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totals]) => ({
      currency,
      ...totals,
      bridgeDifference:
        totals.closingDifference - totals.openingDifference - totals.movementDifference,
    }));
  return {
    rows,
    currencies,
    empty: rows.length === 0,
    allZero:
      rows.length > 0 &&
      rows.every(
        ({ opening, debit, credit, closing }) =>
          opening === BigInt(0) &&
          debit === BigInt(0) &&
          credit === BigInt(0) &&
          closing === BigInt(0)
      ),
    inconsistent:
      rows.some(({ rowDifference }) => rowDifference !== BigInt(0)) ||
      currencies.some(({ bridgeDifference }) => bridgeDifference !== BigInt(0)),
  };
}
