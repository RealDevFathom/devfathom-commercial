/** A display name. A raw user id is not a name. */
export function registerPersonName(name: string | null | undefined, id: string): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed === id) return null;
  return trimmed;
}

export function chooseRegisterPersonName(
  candidates: readonly (string | null | undefined)[],
  id: string
): string | null {
  for (const candidate of candidates) {
    const name = registerPersonName(candidate, id);
    if (name) return name;
  }
  return null;
}

/**
 * Inclusive millisecond bounds for a printed-register period, read as Karachi
 * calendar days (Pakistan is a fixed UTC+5 with no daylight-saving shift). An empty
 * or malformed end of the range is left open.
 */
export function registerPeriodBounds(
  from: string,
  to: string
): { fromMs: number | null; toMs: number | null } {
  const fromMs = from ? Date.parse(`${from}T00:00:00.000+05:00`) : NaN;
  const toMs = to ? Date.parse(`${to}T23:59:59.999+05:00`) : NaN;
  return {
    fromMs: Number.isNaN(fromMs) ? null : fromMs,
    toMs: Number.isNaN(toMs) ? null : toMs,
  };
}

/** Whether an entry's timestamp falls inside a (possibly half-open) register period. */
export function withinRegisterPeriod(
  at: Date,
  bounds: { fromMs: number | null; toMs: number | null }
): boolean {
  const ms = at.getTime();
  if (bounds.fromMs !== null && ms < bounds.fromMs) return false;
  if (bounds.toMs !== null && ms > bounds.toMs) return false;
  return true;
}

export type RegisterPrintRow = {
  inventoryLotId: string;
  batchNumber: string;
  balanceDelta: number;
  runningBalance: number;
  serial: number;
};

/** Totals a printed register can check against the rows themselves. */
export function registerPrintTotals(entries: readonly RegisterPrintRow[]) {
  let unitsIn = 0;
  let unitsOut = 0;
  const closing = new Map<
    string,
    { batchNumber: string; runningBalance: number; serial: number }
  >();
  for (const entry of entries) {
    if (entry.balanceDelta > 0) unitsIn += entry.balanceDelta;
    if (entry.balanceDelta < 0) unitsOut += -entry.balanceDelta;
    const current = closing.get(entry.inventoryLotId);
    if (!current || entry.serial >= current.serial) {
      closing.set(entry.inventoryLotId, {
        batchNumber: entry.batchNumber,
        runningBalance: entry.runningBalance,
        serial: entry.serial,
      });
    }
  }
  return { rows: entries.length, unitsIn, unitsOut, closing: [...closing.values()] };
}
