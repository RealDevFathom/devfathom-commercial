/** Deterministic stock evidence shared by posting, reversal and receipt reads. */
export function acceptedKey(receiptLineId: string): string {
  return `pharmacy-receipt:${receiptLineId}:accepted`;
}

export function quarantineKey(receiptLineId: string): string {
  return `pharmacy-receipt:${receiptLineId}:quarantine`;
}

export function goodsReceiptMovementKeys(lineIds: readonly string[]): string[] {
  return lineIds.flatMap((id) => [acceptedKey(id), quarantineKey(id)]);
}
