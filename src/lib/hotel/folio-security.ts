export const HOTEL_FOLIO_CAPABILITY = 'hotel:folio' as const;
export type FolioEvidence = { id: string; folioNumber: string; status: string; currency: string; balanceMinor: number };
export type ReservationWithOptionalFolio<T> = T & ({ folioAccess: false } | { folioAccess: true; folio: FolioEvidence | null });

/** The sole shared folio projection gate used by reservation/front-desk/inventory/report/AI callers. */
export function projectReservationFolio<T extends object>(reservation: T, folio: FolioEvidence | null, capabilities: ReadonlySet<string>): ReservationWithOptionalFolio<T> {
  return capabilities.has(HOTEL_FOLIO_CAPABILITY)
    ? { ...reservation, folioAccess: true, folio }
    : { ...reservation, folioAccess: false };
}

export function assertAppendOnlyCorrection(input: { reversesId?: string; reason?: string }) {
  if (!input.reversesId || !input.reason?.trim()) throw new Error('Money corrections require a linked reversing entry and reason.');
}
