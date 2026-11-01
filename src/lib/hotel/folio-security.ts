export const HOTEL_FOLIO_CAPABILITY = 'hotel:folio' as const;
/** Folio fields a reservation read may carry; `balanceMinor` nets entries, reversals and payments. */
export type FolioEvidence = { id: string; folioNumber: string; status: string; currency: string; balanceMinor: bigint };
export type ReservationWithOptionalFolio<T> = T & ({ folioAccess: false } | { folioAccess: true; folio: FolioEvidence | null });

/** The sole folio projection gate: without `hotel:folio` the folio is absent, not redacted. */
export function projectReservationFolio<T extends object>(reservation: T, folio: FolioEvidence | null, capabilities: ReadonlySet<string>): ReservationWithOptionalFolio<T> {
  return capabilities.has(HOTEL_FOLIO_CAPABILITY)
    ? { ...reservation, folioAccess: true, folio }
    : { ...reservation, folioAccess: false };
}

export function assertAppendOnlyCorrection(input: { reversesId?: string; reason?: string }) {
  if (!input.reversesId || !input.reason?.trim()) throw new Error('Money corrections require a linked reversing entry and reason.');
}
