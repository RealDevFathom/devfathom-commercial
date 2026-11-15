import { formatMinor, formatReceiptIssuedAt } from './counter-receipt';

export type KhataPaymentSlipSource = {
  receiptReference: string;
  accountName: string;
  amountMinor: number;
  tender: string;
  payerReference: string | null;
  balanceAfterMinor: number;
  recordedAt: Date;
  currency: string;
};

export const KHATA_TENDER_LABELS: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  RAAST: 'Raast',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
};

/** Plain-text slip lines; printed through `textContent`, so no markup is ever built. */
export function khataPaymentSlipLines(slip: KhataPaymentSlipSource, branchName?: string) {
  return [
    'KHATA PAYMENT RECEIPT',
    ...(branchName ? [branchName] : []),
    `Ref: ${slip.receiptReference}`,
    `Date: ${formatReceiptIssuedAt(slip.recordedAt.toISOString())}`,
    `Account: ${slip.accountName}`,
    `Received: ${slip.currency} ${formatMinor(slip.amountMinor)}`,
    `Tender: ${KHATA_TENDER_LABELS[slip.tender] ?? slip.tender}`,
    ...(slip.payerReference ? [`Payer reference: ${slip.payerReference}`] : []),
    `Balance still owed: ${slip.currency} ${formatMinor(slip.balanceAfterMinor)}`,
    'Thank you.',
  ];
}

/** Whole or two-decimal major units to minor units; anything else is 0 (invalid). */
export function parseMajorToMinor(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return 0;
  const [major, fraction = ''] = trimmed.split('.');
  const minor = Number(major) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : 0;
}
