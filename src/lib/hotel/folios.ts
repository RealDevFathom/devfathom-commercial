export type FolioPostingAmount = { totalMinor: number; currency: string };
export type FolioPaymentAmount = { amountMinor: number; currency: string; direction: 'COLLECTION' | 'REFUND' };

/** The ledger is authoritative: charges increase the balance and collections reduce it. */
export function calculateFolioBalance(currency: string, postings: readonly FolioPostingAmount[], payments: readonly FolioPaymentAmount[]): number {
  for (const row of [...postings, ...payments]) if (row.currency !== currency) throw new Error('Folio currency mismatch.');
  return postings.reduce((sum, row) => sum + row.totalMinor, 0) + payments.reduce((sum, row) => sum + (row.direction === 'REFUND' ? row.amountMinor : -row.amountMinor), 0);
}

export function hotelDateKey(date: Date): string { return date.toISOString().slice(0, 10); }
export function stayDates(arrival: Date, departure: Date): Date[] {
  const dates: Date[] = [];
  for (const day = new Date(arrival); day < departure; day.setUTCDate(day.getUTCDate() + 1)) dates.push(new Date(day));
  return dates;
}
