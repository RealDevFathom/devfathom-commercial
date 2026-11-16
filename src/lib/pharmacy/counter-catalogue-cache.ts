import type { CounterSearchRow } from './counter';

/**
 * A mounted operator's bounded, short-lived barcode catalogue hints. These are
 * never cart/price/stock authority: addLine still validates every sale on the
 * server. Keep the existing counter search's ten-second freshness ceiling.
 * Restricted and serialized products always take the live lookup path.
 */
export class CounterCatalogueCache {
  private readonly entries = new Map<string, { row: CounterSearchRow; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(code: string): CounterSearchRow | undefined {
    const entry = this.entries.get(code);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(code);
      return undefined;
    }
    return entry.row;
  }

  put(code: string, row: CounterSearchRow): void {
    if (
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
    this.entries.delete(code);
    if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(code, { row: structuredClone(row), expiresAt: this.now() + 10_000 });
  }

  /** Debit all aliases after a confirmed write; never extend catalogue age. */
  sold(medicineId: string, canonicalUnits: number): void {
    for (const [code, entry] of this.entries) {
      if (entry.row.medicineId !== medicineId) continue;
      // This is aggregate availability for the preview, never a lot allocation.
      // Exhausted hints must be fetched again; the server chooses and prices
      // the actual lot on every add, including when a sale crosses a lot boundary.
      const onHandUnits = entry.row.onHandUnits - canonicalUnits;
      if (onHandUnits <= 0) this.entries.delete(code);
      else entry.row = { ...entry.row, onHandUnits };
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
