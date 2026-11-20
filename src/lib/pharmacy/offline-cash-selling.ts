/**
 * DEV-957 phase 2 (review B1): the owner's switch for offline cash selling.
 *
 * A counter that takes cash offline must be able to send those sales to the server. That
 * is phase 3 (replay, conflicts and the manager recovery screen), so in this phase the
 * switch is OFF for every organisation and CANNOT be turned on: the server refuses to
 * enable it (`setOfflineCashSelling`), every signed RULES snapshot says `false`, and a
 * counter whose signed rules do not say `true` works as a price check only, exactly as
 * after phase 1. Phase 3 stores the owner's choice and sets
 * `OFFLINE_CASH_SELLING_AVAILABLE`; until then nothing in the product can switch it on.
 *
 * Tests that exercise the selling code force it on by mocking this module.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** False until sending offline sales to the server (phase 3) is ready. */
export const OFFLINE_CASH_SELLING_AVAILABLE = false;

/** What the owner and the counter see. */
export const OFFLINE_CASH_SELLING_UNAVAILABLE_MESSAGE =
  'Offline cash selling becomes available when sending offline sales to the server is ready.';

export type OfflineCashSellingSetting = {
  /** In force for this organisation's counters (signed into every RULES snapshot). */
  enabled: boolean;
  /** Whether the owner may switch it on at all in this version. */
  available: boolean;
};

export class OfflineCashSellingError extends Error {
  constructor(readonly reason: 'NOT_AVAILABLE') {
    super(reason);
  }
}

/**
 * The organisation's setting. In this phase there is nothing stored to read: it is off,
 * and not available to switch on.
 */
export async function readOfflineCashSelling(
  db: ScopedDb,
  organizationId: string
): Promise<OfflineCashSellingSetting> {
  // Nothing is stored in this phase; phase 3 reads the owner's stored choice from `db`.
  void db;
  return { enabled: false, available: OFFLINE_CASH_SELLING_AVAILABLE && organizationId.length > 0 };
}

/**
 * The owner's write. Switching it on is refused while it is not available; switching it
 * off (or asking for the state already in force) changes nothing.
 */
export async function writeOfflineCashSelling(
  db: ScopedDb,
  organizationId: string,
  input: { enabled: boolean }
): Promise<{ changed: false; setting: OfflineCashSellingSetting }> {
  const setting = await readOfflineCashSelling(db, organizationId);
  if (input.enabled && !setting.enabled) throw new OfflineCashSellingError('NOT_AVAILABLE');
  return { changed: false, setting };
}
