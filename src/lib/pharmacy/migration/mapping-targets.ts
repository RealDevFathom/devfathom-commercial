/**
 * PH-MIG / MIG-02 — the mapping target key contract.
 *
 * A profiled row says WHAT it should become without importing anything from the
 * PH-MED lane. The link is a stable STRING KEY, not a Prisma model, a foreign
 * key, or a type import, so this module compiles and its suites pass whether or
 * not the MED-* models exist in the tree yet. When PH-MED lands, its loader
 * resolves these keys; nothing here changes.
 *
 * The keys below are the exact MIG-02 mapping targets ("products/packs/barcodes,
 * batches/expiry/MRP, locations, parties/balances, history, users") and no
 * others. A key is a permanent identifier: rename it and every already-profiled
 * `pharmacy_migration_rows.targetModelKey` in the field becomes unresolvable, so
 * treat the strings as data, not as code that may be refactored.
 */

export const MIGRATION_TARGET_KEYS = {
  /** MED-01 medicine identity — one sellable medicine. */
  PRODUCT: 'med.product',
  /** MED-02 pack hierarchy — a pack presentation of a product. */
  PACK: 'med.pack',
  /** MED-02 — a scanned code resolving to a product or pack. */
  BARCODE: 'med.barcode',
  /** Batch identity plus its expiry and MRP (MED-07/08 derive unit price). */
  BATCH: 'med.batch',
  /** A storage location / branch shelf in the receiving organization. */
  LOCATION: 'inv.location',
  /** A supplier or customer party. */
  PARTY: 'party',
  /** A retail customer (kept distinct so commit cannot guess from column names). */
  CUSTOMER: 'party.customer',
  /** A procurement supplier (kept distinct so commit cannot guess from column names). */
  SUPPLIER: 'party.supplier',
  /** A party's opening balance. */
  PARTY_BALANCE: 'party.balance',
  /** A historical incumbent document (invoice, return, receipt). */
  HISTORY_DOCUMENT: 'history.document',
  /** An incumbent operator account. */
  USER: 'iam.user',
} as const;

export type MigrationTargetKey = (typeof MIGRATION_TARGET_KEYS)[keyof typeof MIGRATION_TARGET_KEYS];

const ALL_TARGET_KEYS: readonly MigrationTargetKey[] = Object.values(MIGRATION_TARGET_KEYS);

export function isMigrationTargetKey(value: string): value is MigrationTargetKey {
  return (ALL_TARGET_KEYS as readonly string[]).includes(value);
}

/**
 * Build the natural key a target row will be matched on once PH-MED loads it.
 *
 * Normalization is deliberate and narrow: trim, collapse internal whitespace,
 * casefold. It is NOT a cleanup pass — it never drops characters, so two
 * incumbent spellings that differ by more than spacing stay distinct and reach a
 * human rather than being silently merged.
 */
export function naturalKey(target: MigrationTargetKey, ...parts: readonly string[]): string {
  const normalized = parts
    .map((part) => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((part) => part.length > 0);
  return `${target}:${normalized.join('|')}`;
}
