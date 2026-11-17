import type { CounterSearchRow } from './counter';

/**
 * A mounted operator's bounded, short-lived barcode catalogue hints. These are
 * never cart/price/stock authority: addLine still validates every sale on the
 * server. Keep the existing counter search's ten-second freshness ceiling.
 * Restricted and serialized products always take the live lookup path.
 * Entries are keyed by branch as well as code, so one branch's hint never
 * answers another branch's scan.
 */
export class CounterCatalogueCache {
  private readonly entries = new Map<string, { row: CounterSearchRow; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(branchId: string, code: string): CounterSearchRow | undefined {
    const key = cacheKey(branchId, code);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.row;
  }

  put(branchId: string, code: string, row: CounterSearchRow): void {
    if (
      !branchId ||
      !/^\d{6,}$/.test(code) ||
      row.matchedOn !== 'BARCODE' ||
      !row.restriction.otc ||
      row.restriction.controlled ||
      row.restriction.rx ||
      row.restriction.restricted ||
      row.restriction.highAlert ||
      row.restriction.lasa ||
      row.blocked.length > 0 ||
      row.onHandUnits <= 0
    )
      return;
    const key = cacheKey(branchId, code);
    this.entries.delete(key);
    if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { row: structuredClone(row), expiresAt: this.now() + 10_000 });
  }

  /** Debit all aliases after a confirmed write; never extend catalogue age. */
  sold(medicineId: string, canonicalUnits: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.row.medicineId !== medicineId) continue;
      // This is aggregate availability for the preview, never a lot allocation.
      // Exhausted hints must be fetched again; the server chooses and prices
      // the actual lot on every add, including when a sale crosses a lot boundary.
      const onHandUnits = entry.row.onHandUnits - canonicalUnits;
      if (onHandUnits <= 0) this.entries.delete(key);
      else entry.row = { ...entry.row, onHandUnits };
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

function cacheKey(branchId: string, code: string): string {
  return JSON.stringify([branchId, code]);
}
