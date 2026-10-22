/** Vertical-neutral stored-value account contracts. Amounts are integer paisa. */
export type StoredValueAccountKind = 'CUSTOMER_LIABILITY' | 'CASH_CLEARING' | 'SALES_CLEARING';

export type StoredValueAccount = {
  id: string;
  organizationId: string;
  customerId: string | null;
  kind: StoredValueAccountKind;
  balanceMinor: number;
};

export function assertMinor(amountMinor: number, allowNegative = false): void {
  if (!Number.isSafeInteger(amountMinor) || (!allowNegative && amountMinor <= 0)) {
    throw new RangeError('Amount must be a positive integer number of paisa.');
  }
}

export function deriveBalance(entries: readonly { amountMinor: number }[]): number {
  return entries.reduce((balance, entry) => {
    assertMinor(entry.amountMinor, true);
    return balance + entry.amountMinor;
  }, 0);
}
