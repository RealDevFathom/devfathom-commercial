/**
 * #763 — purchase-bill input-tax hygiene.
 *
 * This is a reporting control, not a posting gate. A bill remains a faithful
 * record even when its distributor tax identity is incomplete; the report
 * flags positive input-tax claims and keeps claimed tax visible for reconciliation.
 */

export type InputTaxBill = {
  id: string;
  reference: string;
  supplierInvoiceRef: string;
  supplier: { name: string };
  distributorNtn: string | null;
  distributorStrn: string | null;
  status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED';
  lines: readonly {
    receivedPacks: number;
    invoicedPricePerPackMinor: number;
    discountBps: number;
    taxBps: number;
    taxCreditable: boolean;
  }[];
};

export type InputTaxBillReconciliation = {
  id: string;
  reference: string;
  supplierInvoiceRef: string;
  supplierName: string;
  missing: ('NTN' | 'STRN')[];
  flagged: boolean;
  claimMinor: number;
};

const BPS = 10_000;
const roundHalfUp = (numerator: number) => Math.floor((numerator + BPS / 2) / BPS);

function claimedInputTaxMinor(bill: InputTaxBill): number {
  if (bill.status !== 'POSTED') return 0;
  return bill.lines.reduce((total, line) => {
    if (!line.taxCreditable) return total;
    const gross = line.receivedPacks * line.invoicedPricePerPackMinor;
    const discount = roundHalfUp(gross * line.discountBps);
    return total + roundHalfUp((gross - discount) * line.taxBps);
  }, 0);
}

export function reconcileInputTaxBills(bills: readonly InputTaxBill[]) {
  const rows: InputTaxBillReconciliation[] = bills
    .filter((bill) => bill.status !== 'CANCELLED')
    .map((bill) => {
      const missing: ('NTN' | 'STRN')[] = [];
      if (!bill.distributorNtn?.trim()) missing.push('NTN');
      if (!bill.distributorStrn?.trim()) missing.push('STRN');
      const claimMinor = claimedInputTaxMinor(bill);
      return {
        id: bill.id,
        reference: bill.reference,
        supplierInvoiceRef: bill.supplierInvoiceRef,
        supplierName: bill.supplier.name,
        missing,
        flagged: claimMinor > 0 && missing.length > 0,
        claimMinor,
      };
    });

  return {
    rows,
    flaggedBillCount: rows.filter((row) => row.flagged).length,
    claimedInputTaxMinor: rows.reduce((total, row) => total + row.claimMinor, 0),
    flaggedClaimMinor: rows
      .filter((row) => row.flagged)
      .reduce((total, row) => total + row.claimMinor, 0),
  };
}
