/**
 * M9-L1 — the POS terminal's client-side persistence seam.
 *
 * This module is CLIENT-SAFE on purpose: it never imports `server-only`, Prisma or
 * any terminal/auth helper, so bundling it into the POS page cannot drag a server
 * module across the boundary.
 *
 * The scope partitioning, the storage-minimization denylist, the IndexedDB driver
 * seam and the versioned read/write/purge now live in the NEUTRAL retail-terminal
 * seam (`@/lib/retail-terminal/local-store`, PRD §11), because the Pharmacy counter
 * needs exactly the same three guarantees:
 *
 *  1. **A native IndexedDB seam.** One tiny driver interface (`PosStorageDriver`)
 *     with a native `indexedDB` implementation and an in-memory implementation for
 *     tests/SSR. No service worker, PWA runtime, sync library or second database
 *     (M9 §3.4, §3.10) — jsdom ships no IndexedDB, so the seam is how the battery
 *     runs without adding a dependency.
 *  2. **A schema-versioned, scope-partitioned record.** Exactly one document per
 *     `organization + branch + device` (criterion 2). Catalog, drafts and queue live
 *     in that single document, so every write is one `put` inside one IndexedDB
 *     transaction — catalog/draft/queue writes are atomic by construction. An
 *     unknown schema version or a corrupt/foreign document FAILS CLOSED: the read
 *     reports `unrecoverable` and the caller shows recovery UI instead of guessing.
 *  3. **Storage minimization, enforced not documented.** Every write is walked by
 *     `assertPersistSafe`, which throws on a forbidden key (device/enrollment
 *     secrets, session tokens, operator/manager PINs, customer or loyalty fields,
 *     tender/payment/card values) and on any non-JSON value.
 *
 * What is NOT shared, and stays here: the effective-menu ALLOWLIST projection and
 * the POS refresh policy. A menu is not a medicine catalogue, so the two verticals
 * sanitize their own payloads; the denylist + this allowlist together remain the
 * audit proof for criterion 2. Every symbol this module exported before the
 * extraction is still exported from here, under the same name.
 *
 * Client-origin time is persisted as metadata only; server time stays authoritative
 * and queue ordering uses a persisted sequence, never a clock (M9 amendment §2.3).
 */
import {
  TerminalStorageError,
  assertPersistSafe,
  createTerminalIndexedDbDriver,
  emptyTerminalState,
  purgeTerminalScope,
  readTerminalState,
  resolveIndexedDbFactory,
  sameTerminalScope,
  terminalScopeKey,
  writeTerminalState,
} from '@/lib/retail-terminal/local-store';
import type {
  PersistedTerminalState,
  TerminalScope,
  TerminalStorageDriver,
  TerminalStoreReadResult,
} from '@/lib/retail-terminal/local-store';

export {
  FORBIDDEN_PERSIST_KEYS,
  FORBIDDEN_PERSIST_KEY_STEMS,
  assertPersistSafe,
  createMemoryDriver,
  findForbiddenPersistPath,
  isForbiddenPersistKey,
  resolveIndexedDbFactory,
  TerminalStorageError as PosStorageError,
} from '@/lib/retail-terminal/local-store';
export type { TerminalStorageErrorReason as PosStorageErrorReason } from '@/lib/retail-terminal/local-store';

/** The whole browser-storage surface the POS is allowed to use. One document per
 * scope key, read/written/removed whole — which is exactly why a catalog + draft +
 * queue update is atomic (criterion 2). */
export type PosStorageDriver = TerminalStorageDriver;

/** Bump when the persisted document shape changes; an older/newer record fails closed. */
export const POS_STORE_SCHEMA_VERSION = 1;

export const POS_STORE_DATABASE_NAME = 'devfathom-pos';
export const POS_STORE_OBJECT_STORE = 'scope-state';

const POS_STORE_DATABASE = {
  databaseName: POS_STORE_DATABASE_NAME,
  objectStoreName: POS_STORE_OBJECT_STORE,
  schemaVersion: POS_STORE_SCHEMA_VERSION,
} as const;

/** The catalog refresh cadence while the terminal is active (M9 §3.6). */
export const CATALOG_REFRESH_INTERVAL_MS = 30_000;

// ── Scope partitioning ───────────────────────────────────────────────────────

export type PosScope = TerminalScope;

export function posScopeKey(scope: PosScope): string {
  return terminalScopeKey(scope);
}

export function sameScope(a: PosScope, b: PosScope): boolean {
  return sameTerminalScope(a, b);
}

// ── Versioned catalog snapshot (criteria 2 and 5) ────────────────────────────

export type PosOrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export type PosCatalogItem = {
  menuItemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  sortOrder: number;
  /** Server-authored Decimal string, or null when the item has no effective price. */
  price: string | null;
  priceSource: 'OVERRIDE' | 'PUBLICATION_LIST' | 'BASE_LIST' | 'NONE';
  available: boolean;
  modifierGroups?: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number | null;
    options: Array<{ id: string; name: string; priceDelta: string }>;
  }>;
};

export type PosCatalogSection = {
  sectionId: string;
  name: string;
  sortOrder: number;
  items: PosCatalogItem[];
};

export type PosCatalogSnapshot = {
  /** The server's deterministic effective-menu version (its ETag payload). */
  version: string;
  branchId: string;
  channel: PosOrderChannel;
  publicationId: string;
  channelOpen: boolean;
  menuId: string;
  menuName: string;
  sections: PosCatalogSection[];
  /** Client-origin UTC instant, metadata only — never an ordering or pricing input. */
  fetchedAtClient: string;
};

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TerminalStorageError('MALFORMED_CATALOG', `Effective menu field ${path} is missing.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TerminalStorageError('MALFORMED_CATALOG', `Effective menu field ${path} is missing.`);
  }
  return value;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TerminalStorageError(
      'MALFORMED_CATALOG',
      `Effective menu field ${path} is not an object.`
    );
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TerminalStorageError(
      'MALFORMED_CATALOG',
      `Effective menu field ${path} is not a list.`
    );
  }
  return value;
}

/**
 * Project the effective-menu response onto the ALLOWLIST the terminal is permitted
 * to keep. Everything not named here is dropped — including the localized name
 * blobs, which are free-form JSON the store has no reason to hold (D20 ships no
 * localized claim). A field added to the server payload later cannot leak into
 * browser storage without a deliberate edit here.
 */
export function sanitizeCatalogSnapshot(
  payload: unknown,
  meta: { version: string; fetchedAtClient: string }
): PosCatalogSnapshot {
  const root = asRecord(payload, 'response');
  const menu = asRecord(root.menu, 'menu');
  const channel = requireString(root.channel, 'channel');
  if (channel !== 'DINE_IN' && channel !== 'TAKEAWAY' && channel !== 'DELIVERY') {
    throw new TerminalStorageError(
      'MALFORMED_CATALOG',
      'Effective menu channel is not a POS channel.'
    );
  }

  const snapshot: PosCatalogSnapshot = {
    version: requireString(meta.version, 'version'),
    branchId: requireString(root.branchId, 'branchId'),
    channel,
    publicationId: requireString(root.publicationId, 'publicationId'),
    channelOpen: root.channelOpen === true,
    menuId: requireString(menu.id, 'menu.id'),
    menuName: requireString(menu.name, 'menu.name'),
    fetchedAtClient: requireString(meta.fetchedAtClient, 'fetchedAtClient'),
    sections: asArray(root.sections, 'sections').map((rawSection, sectionIndex) => {
      const section = asRecord(rawSection, `sections[${sectionIndex}]`);
      return {
        sectionId: requireString(section.id, `sections[${sectionIndex}].id`),
        name: requireString(section.name, `sections[${sectionIndex}].name`),
        sortOrder: requireNumber(section.sortOrder, `sections[${sectionIndex}].sortOrder`),
        items: asArray(section.items, `sections[${sectionIndex}].items`).map(
          (rawItem, itemIndex) => {
            const at = `sections[${sectionIndex}].items[${itemIndex}]`;
            const item = asRecord(rawItem, at);
            const product = asRecord(item.product, `${at}.product`);
            const source = requireString(item.priceSource, `${at}.priceSource`);
            if (
              source !== 'OVERRIDE' &&
              source !== 'PUBLICATION_LIST' &&
              source !== 'BASE_LIST' &&
              source !== 'NONE'
            ) {
              throw new TerminalStorageError('MALFORMED_CATALOG', `${at}.priceSource is unknown.`);
            }
            return {
              menuItemId: requireString(item.id, `${at}.id`),
              productId: requireString(item.productId, `${at}.productId`),
              variantId: optionalString(item.variantId),
              name: optionalString(item.displayName) ?? requireString(product.name, `${at}.name`),
              sortOrder: requireNumber(item.sortOrder, `${at}.sortOrder`),
              price: optionalString(item.price),
              priceSource: source,
              available: item.available === true,
              modifierGroups: asArray(item.modifierGroups, `${at}.modifierGroups`).map(
                (rawGroup, groupIndex) => {
                  const groupAt = `${at}.modifierGroups[${groupIndex}]`;
                  const group = asRecord(rawGroup, groupAt);
                  return {
                    id: requireString(group.id, `${groupAt}.id`),
                    name: requireString(group.name, `${groupAt}.name`),
                    minSelect: requireNumber(group.minSelect, `${groupAt}.minSelect`),
                    maxSelect:
                      group.maxSelect === null
                        ? null
                        : requireNumber(group.maxSelect, `${groupAt}.maxSelect`),
                    options: asArray(group.options, `${groupAt}.options`).map(
                      (rawOption, optionIndex) => {
                        const optionAt = `${groupAt}.options[${optionIndex}]`;
                        const option = asRecord(rawOption, optionAt);
                        return {
                          id: requireString(option.id, `${optionAt}.id`),
                          name: requireString(option.name, `${optionAt}.name`),
                          priceDelta: requireString(option.priceDelta, `${optionAt}.priceDelta`),
                        };
                      }
                    ),
                  };
                }
              ),
            } satisfies PosCatalogItem;
          }
        ),
      } satisfies PosCatalogSection;
    }),
  };

  // Belt and braces: the allowlist above already drops unknown fields, but a future
  // edit that widens it still cannot get a denylisted key past this call.
  assertPersistSafe(snapshot);
  return snapshot;
}

/** Look one item up in the cached catalog (an item tap must not need a fetch). */
export function findCatalogItem(
  catalog: PosCatalogSnapshot,
  menuItemId: string
): PosCatalogItem | null {
  for (const section of catalog.sections) {
    for (const item of section.items) {
      if (item.menuItemId === menuItemId) return item;
    }
  }
  return null;
}

export type CatalogRefreshTrigger =
  'UNLOCK' | 'RECONNECT' | 'ONLINE' | 'VISIBILITY' | 'INTERVAL' | 'MANUAL';

/**
 * The refresh policy from M9 §3.6, kept here as a pure decision so the POS surface
 * (L3) only has to wire it to `online`, `visibilitychange`, unlock and a timer.
 * Recovery-shaped triggers always refresh; the periodic tick refreshes at most once
 * per `CATALOG_REFRESH_INTERVAL_MS`, and a terminal with no catalog always refreshes.
 */
export function shouldRefreshCatalog(input: {
  trigger: CatalogRefreshTrigger;
  nowMs: number;
  lastAttemptAtMs: number | null;
  hasCatalog: boolean;
}): boolean {
  if (!input.hasCatalog) return true;
  if (input.trigger !== 'INTERVAL') return true;
  if (input.lastAttemptAtMs === null) return true;
  return input.nowMs - input.lastAttemptAtMs >= CATALOG_REFRESH_INTERVAL_MS;
}

// ── The persisted document ───────────────────────────────────────────────────

/**
 * One terminal's whole local state. `Q` is the queue snapshot owned by
 * `pos-command-queue.ts`; keeping it generic means the queue depends on the store
 * and never the reverse. The document shape, its scope check and its atomic write
 * belong to the neutral seam; only the POS catalogue type is bound here.
 */
export type PosPersistedState<Q = unknown> = PersistedTerminalState<Q, PosCatalogSnapshot>;

export function emptyPosState<Q>(scope: PosScope): PosPersistedState<Q> {
  return emptyTerminalState<Q, PosCatalogSnapshot>(scope, POS_STORE_SCHEMA_VERSION);
}

// ── The IndexedDB seam ───────────────────────────────────────────────────────

export function isPosStoreSupported(): boolean {
  return resolveIndexedDbFactory() !== null;
}

/**
 * The native driver, bound to the POS database name and schema version. `write` is
 * a single `put` of the whole document, so a torn catalog/queue pair is not
 * representable (criterion 2).
 */
export function createIndexedDbDriver(factory: IDBFactory | null = null): PosStorageDriver {
  return createTerminalIndexedDbDriver(POS_STORE_DATABASE, factory);
}

// ── Read / write / purge ─────────────────────────────────────────────────────

export type PosStoreReadResult<Q> = TerminalStoreReadResult<Q, PosCatalogSnapshot>;

/**
 * Read this scope's document. A missing document is `empty` (a fresh terminal); a
 * document written by another schema version, another scope, or a corrupt one is
 * `unrecoverable` — the caller must NOT guess at it, it must offer recovery
 * (discard local state and re-sync) as criterion 2 requires.
 */
export async function readPosState<Q>(
  driver: PosStorageDriver,
  scope: PosScope
): Promise<PosStoreReadResult<Q>> {
  return readTerminalState<Q, PosCatalogSnapshot>(driver, scope, POS_STORE_SCHEMA_VERSION);
}

/**
 * Persist this scope's whole document in one atomic write, after the minimization
 * guard. A forbidden field throws BEFORE anything reaches the browser.
 */
export async function writePosState<Q>(
  driver: PosStorageDriver,
  state: PosPersistedState<Q>,
  expectedRevision?: number
): Promise<number> {
  return writeTerminalState(driver, state, POS_STORE_SCHEMA_VERSION, expectedRevision);
}

/**
 * Drop this terminal's whole document. This is the confirmed-revocation purge path
 * (M9 amendment §2.2 / criterion 4) and the recovery path for an unrecoverable read.
 */
export async function purgePosScope(driver: PosStorageDriver, scope: PosScope): Promise<void> {
  await purgeTerminalScope(driver, scope);
}
