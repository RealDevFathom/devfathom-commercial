/**
 * The one folio sign convention (migration 20261101000000): every amount is a
 * non-negative BigInt minor-unit snapshot. A correction is a positive copy of
 * the original naming it in `reversesEntryId`, so the balance subtracts it.
 */
export type FolioEntryAmount = {
  grossMinor: bigint;
  currency: string;
  reversesEntryId: string | null;
};
export type FolioPaymentAmount = {
  amountMinor: bigint;
  currency: string;
  direction: 'COLLECTION' | 'REFUND';
};

/** Charges minus reversals, minus collections, plus refunds. Positive means the guest owes. */
export function calculateFolioBalance(
  currency: string,
  entries: readonly FolioEntryAmount[],
  payments: readonly FolioPaymentAmount[]
): bigint {
  for (const row of [...entries, ...payments]) {
    if (row.currency !== currency) throw new Error('Folio currency mismatch.');
  }
  const charges = entries.reduce(
    (sum, row) => (row.reversesEntryId ? sum - row.grossMinor : sum + row.grossMinor),
    BigInt(0)
  );
  return payments.reduce(
    (sum, row) => (row.direction === 'REFUND' ? sum + row.amountMinor : sum - row.amountMinor),
    charges
  );
}
