import { COUNTER_RECEIPT_STRINGS, type CounterReceipt } from './counter-receipt';

/**
 * DEV-16: what a hosted receipt page shows to the link holder: every purchased
 * line, like paper, built from the same counter receipt model, minus staff
 * identity, batch and allocation detail.
 */
export type HostedReceiptView = {
  branchName: string;
  receiptNumber: number;
  completedAt: string | null;
  currency: string;
  lines: {
    id: string;
    name: string;
    strength: string | null;
    quantity: number;
    saleUnit: string;
    lineTotalMinor: number;
  }[];
  tenders: { id: string; label: string; amountMinor: number }[];
  totals: { grossMinor: number; discountMinor: number; netMinor: number };
};

export function hostedReceiptView(receipt: CounterReceipt): HostedReceiptView | null {
  if (receipt.receiptNumber === null || !receipt.completedAt) return null;
  const strings = COUNTER_RECEIPT_STRINGS.en;
  return {
    branchName: receipt.branchName,
    receiptNumber: receipt.receiptNumber,
    completedAt: receipt.completedAt,
    currency: receipt.currency,
    lines: receipt.lines.map((line) => ({
      id: line.saleLineId,
      name: line.medicineName,
      strength: line.strength,
      quantity: line.quantity,
      saleUnit: strings.saleUnit[line.saleUnit] ?? line.saleUnit,
      lineTotalMinor: line.lineTotalMinor,
    })),
    tenders: receipt.tenders.map((tender) => ({
      id: tender.tenderId,
      label: strings.tenderName[tender.type] ?? 'Other',
      amountMinor: tender.amountMinor,
    })),
    totals: {
      grossMinor: receipt.totals.grossMinor,
      discountMinor: receipt.totals.discountMinor,
      netMinor: receipt.totals.netMinor,
    },
  };
}
