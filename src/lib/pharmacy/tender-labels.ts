const PHARMACY_TENDER_LABELS: Readonly<Record<string, string>> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  WALLET: 'Wallet',
  CREDIT: 'Credit',
  LOYALTY: 'Loyalty points',
  RAAST: 'Raast',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
};

/** Customer-facing tender name; never echoes an unknown code or an internal ID. */
export function pharmacyTenderLabel(type: string | null | undefined): string | null {
  return type && Object.hasOwn(PHARMACY_TENDER_LABELS, type) ? PHARMACY_TENDER_LABELS[type]! : null;
}

/** A refund paid from a drawer leaves as cash, whatever the original tender was. */
export function pharmacyRefundTenderLabel(refund: {
  drawerSessionId?: string | null;
  originalTender?: { type: string } | null;
}): string | null {
  return refund.drawerSessionId ? 'Cash' : pharmacyTenderLabel(refund.originalTender?.type);
}
