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
