import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  activateVersion,
  assertVersionMutable,
  nextVersionNumber,
  resolveEffectiveVersion,
  supersedeVersion,
  type EffectiveDatedVersionRecord,
} from './effective-dating';

/**
 * M3-L3 / C3 / C4 — price lists, their effective-dated immutable-once-ACTIVE
 * versions, and entry resolution.
 *
 * A price list owns a sequence of versions; each version carries an
 * `effectiveFrom` and a set of (product, optional variant) → price entries. The
 * price in force at an instant T is the entry of the version resolved by L1's
 * `resolveEffectiveVersion` (the non-DRAFT version with the greatest
 * `effectiveFrom <= T`) — see `resolveEffectivePriceListVersion`. Versions are
 * mutated ONLY through the L1 primitives (`assertVersionMutable`,
 * `activateVersion`, `supersedeVersion`): a DRAFT version is editable, activation
 * freezes it, and a superseded version stays readable forever (GOV-2).
 *
 * Money is Prisma `Decimal` end to end (C4) — no floats. Prices are normalized
 * through `Prisma.Decimal` and never converted to `number`; the router boundary
 * serializes them to strings for transport (superjson does not carry Decimal).
 *
 * Every function takes a tenant-scoped `ScopedDb`; `organizationId` is supplied
 * by the RLS default on each row and is never forged by the caller (C1). A
 * product/variant reference is validated to be an in-scope canonical row before
 * an entry is written, so a price list can never point at another org's catalog.
 */

export type PriceListErrorReason =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_MISMATCH'
  | 'ENTRY_EXISTS'
  | 'DUPLICATE_EFFECTIVE_FROM';

export class PriceListError extends Error {
  constructor(
    message: string,
    readonly reason: PriceListErrorReason
  ) {
    super(message);
    this.name = 'PriceListError';
  }
}

/**
 * Normalize a money input to a non-negative Prisma `Decimal` with at most two
 * fractional digits (the `Decimal(12,2)` column). Rejects NaN/Infinity, negative
 * values, and over-precise or over-large inputs before they reach Postgres.
 */
export function normalizePrice(value: string | number | Prisma.Decimal): Prisma.Decimal {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value);
  } catch {
    throw new PriceListError('Price is not a valid decimal.', 'INVALID');
  }
  if (!decimal.isFinite()) {
    throw new PriceListError('Price must be a finite amount.', 'INVALID');
  }
  if (decimal.isNegative()) {
    throw new PriceListError('Price must not be negative.', 'INVALID');
  }
  if (decimal.decimalPlaces() > 2) {
    throw new PriceListError('Price may have at most two decimal places.', 'INVALID');
  }
  if (decimal.greaterThan('9999999999.99')) {
    throw new PriceListError('Price exceeds the maximum supported amount.', 'INVALID');
  }
  return decimal;
}

/** A referenced product must exist in the caller's organization (RLS scopes the lookup). */
async function assertProductInScope(db: ScopedDb, productId: string): Promise<void> {
  const product = await db.restaurantProduct.findUnique({
    where: { id: productId },
    select: { id: true },
  });
  if (!product) {
    throw new PriceListError('The referenced product does not exist.', 'PRODUCT_NOT_FOUND');
  }
}

/** A referenced variant must exist in scope AND belong to the referenced product. */
async function assertVariantMatchesProduct(
  db: ScopedDb,
  variantId: string,
  productId: string
): Promise<void> {
  const variant = await db.restaurantProductVariant.findUnique({
    where: { id: variantId },
    select: { id: true, productId: true },
  });
  if (!variant) {
    throw new PriceListError('The referenced variant does not exist.', 'VARIANT_NOT_FOUND');
  }
  if (variant.productId !== productId) {
    throw new PriceListError(
      'The referenced variant does not belong to the referenced product.',
      'VARIANT_MISMATCH'
    );
  }
}

// ── Price list + version authoring ──────────────────────────────────────────

export type CreatePriceListInput = { name: string; isDefault?: boolean };

/**
 * Create a price list. When `isDefault` is set, this becomes the organization's
 * base (default) list and any prior default is demoted in the same transaction,
 * so at most one base list exists — the read model resolves the base list by
 * `isDefault` (there is no partial unique index for price lists in the schema, so
 * the invariant is maintained here).
 */
export async function createPriceList(db: ScopedDb, input: CreatePriceListInput) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new PriceListError('A price list requires a name.', 'INVALID');
  }
  const isDefault = input.isDefault ?? false;
  if (!isDefault) {
    return db.restaurantPriceList.create({ data: { name, isDefault: false } });
  }
  return db.$transaction(async (tx) => {
    await tx.restaurantPriceList.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    return tx.restaurantPriceList.create({ data: { name, isDefault: true } });
  });
}

export type CreatePriceListVersionInput = { priceListId: string; effectiveFrom: Date };

/**
 * Open a new DRAFT version of a price list, effective from `effectiveFrom`. The
 * version number is monotonic (one past the current max). A second version for
 * the same instant collides with the `(priceListId, effectiveFrom)` unique index,
 * which is surfaced here as a friendly domain error.
 */
export async function createPriceListVersion(db: ScopedDb, input: CreatePriceListVersionInput) {
  const priceList = await db.restaurantPriceList.findUnique({
    where: { id: input.priceListId },
    select: { id: true },
  });
  if (!priceList) {
    throw new PriceListError('The price list does not exist.', 'NOT_FOUND');
  }

  const existing = await db.restaurantPriceListVersion.findMany({
    where: { priceListId: input.priceListId },
    select: { versionNumber: true, effectiveFrom: true },
  });
  if (existing.some((v) => v.effectiveFrom.getTime() === input.effectiveFrom.getTime())) {
    throw new PriceListError(
      'A version with this effective date already exists for the price list.',
      'DUPLICATE_EFFECTIVE_FROM'
    );
  }

  return db.restaurantPriceListVersion.create({
    data: {
      priceListId: input.priceListId,
      versionNumber: nextVersionNumber(existing),
      effectiveFrom: input.effectiveFrom,
      status: 'DRAFT',
    },
  });
}

/** Load a version guarded to be mutable (DRAFT); throws otherwise (C3). */
async function loadMutableVersion(db: ScopedDb, versionId: string) {
  const version = await db.restaurantPriceListVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true },
  });
  if (!version) {
    throw new PriceListError('The price-list version does not exist.', 'VERSION_NOT_FOUND');
  }
  assertVersionMutable(version); // throws VersionImmutabilityError if not DRAFT
  return version;
}

export type UpsertPriceListEntryInput = {
  priceListVersionId: string;
  productId: string;
  variantId?: string | null;
  price: string | number | Prisma.Decimal;
};

/**
 * Add a price entry to a DRAFT version. Validates the (product, variant) pair as
 * in-scope canonical rows and rejects a duplicate (version, product, variant) —
 * the COALESCE unique index treats the null-variant base row as a single slot.
 */
export async function addPriceListEntry(db: ScopedDb, input: UpsertPriceListEntryInput) {
  await loadMutableVersion(db, input.priceListVersionId);
  const price = normalizePrice(input.price);
  const variantId = input.variantId ?? null;

  await assertProductInScope(db, input.productId);
  if (variantId) await assertVariantMatchesProduct(db, variantId, input.productId);

  const clash = await db.restaurantPriceListEntry.findFirst({
    where: { priceListVersionId: input.priceListVersionId, productId: input.productId, variantId },
    select: { id: true },
  });
  if (clash) {
    throw new PriceListError(
      'A price already exists for this product/variant in the version.',
      'ENTRY_EXISTS'
    );
  }

  return db.restaurantPriceListEntry.create({
    data: {
      priceListVersionId: input.priceListVersionId,
      productId: input.productId,
      variantId,
      price,
    },
  });
}

/** Change the price of an entry; only permitted while the parent version is DRAFT. */
export async function updatePriceListEntry(
  db: ScopedDb,
  entryId: string,
  price: string | number | Prisma.Decimal
) {
  const entry = await db.restaurantPriceListEntry.findUnique({
    where: { id: entryId },
    select: { id: true, priceListVersionId: true },
  });
  if (!entry) {
    throw new PriceListError('The price-list entry does not exist.', 'NOT_FOUND');
  }
  await loadMutableVersion(db, entry.priceListVersionId);
  return db.restaurantPriceListEntry.update({
    where: { id: entryId },
    data: { price: normalizePrice(price) },
  });
}

/** Remove an entry; only permitted while the parent version is DRAFT. */
export async function removePriceListEntry(db: ScopedDb, entryId: string) {
  const entry = await db.restaurantPriceListEntry.findUnique({
    where: { id: entryId },
    select: { id: true, priceListVersionId: true },
  });
  if (!entry) {
    throw new PriceListError('The price-list entry does not exist.', 'NOT_FOUND');
  }
  await loadMutableVersion(db, entry.priceListVersionId);
  await db.restaurantPriceListEntry.delete({ where: { id: entryId } });
  return { id: entryId };
}

/**
 * Activate a DRAFT version (DRAFT -> ACTIVE) at server-supplied `at`. Price-list
 * versions are effective-dated, so activation does NOT supersede prior versions —
 * resolution simply picks the greatest `effectiveFrom <= T` among active/superseded
 * versions. The L1 primitive guards the transition and yields the exact patch.
 */
export async function activatePriceListVersion(db: ScopedDb, versionId: string, at: Date) {
  const version = await db.restaurantPriceListVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true },
  });
  if (!version) {
    throw new PriceListError('The price-list version does not exist.', 'VERSION_NOT_FOUND');
  }
  const patch = activateVersion(version, at); // throws VersionTransitionError if not DRAFT
  return db.restaurantPriceListVersion.update({ where: { id: versionId }, data: patch });
}

/** Supersede an ACTIVE version (ACTIVE -> SUPERSEDED); it stays readable (GOV-2). */
export async function supersedePriceListVersion(db: ScopedDb, versionId: string, at: Date) {
  const version = await db.restaurantPriceListVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true },
  });
  if (!version) {
    throw new PriceListError('The price-list version does not exist.', 'VERSION_NOT_FOUND');
  }
  const patch = supersedeVersion(version, at); // throws VersionTransitionError if not ACTIVE
  return db.restaurantPriceListVersion.update({ where: { id: versionId }, data: patch });
}

// ── Entry resolution ─────────────────────────────────────────────────────────

type EntryLike = { productId: string; variantId: string | null };

/**
 * Pick the winning entry for a (product, variant) request within one version's
 * entries. A variant request prefers its exact (product, variant) entry and falls
 * back to the product's base (null-variant) entry; a base request uses the base
 * entry directly. Returns null when the product is not priced in this version.
 */
export function pickEntry<T extends EntryLike>(
  entries: readonly T[],
  productId: string,
  variantId: string | null
): T | null {
  if (variantId) {
    const exact = entries.find((e) => e.productId === productId && e.variantId === variantId);
    if (exact) return exact;
  }
  return entries.find((e) => e.productId === productId && e.variantId == null) ?? null;
}

export type ResolvedPriceListVersion = {
  id: string;
  versionNumber: number;
  effectiveFrom: Date;
  status: EffectiveDatedVersionRecord['status'];
};

/**
 * Resolve which version of a price list is in force at instant `at` (or null when
 * none is yet in force). Loads the list's non-DRAFT versions and defers the
 * winner selection — including inclusive boundary-instant semantics — to L1's
 * `resolveEffectiveVersion`.
 */
export async function resolveEffectivePriceListVersion(
  db: ScopedDb,
  priceListId: string,
  at: Date
): Promise<ResolvedPriceListVersion | null> {
  const versions = await db.restaurantPriceListVersion.findMany({
    where: { priceListId, status: { not: 'DRAFT' } },
    select: { id: true, versionNumber: true, effectiveFrom: true, status: true },
  });
  return resolveEffectiveVersion(versions, at);
}

export type ResolvedPriceEntry = {
  id: string;
  productId: string;
  variantId: string | null;
  price: Prisma.Decimal;
};

export type ResolvedPriceList = {
  version: ResolvedPriceListVersion;
  entries: ResolvedPriceEntry[];
};

/**
 * Load the price list's in-force version at `at` together with all of its entries,
 * in a single pair of queries. The router read model calls this once per list and
 * resolves every menu item against the returned entries via `pickEntry` (avoiding
 * an N+1 lookup per item). Returns null when nothing is in force.
 */
export async function resolveEffectiveEntries(
  db: ScopedDb,
  priceListId: string,
  at: Date
): Promise<ResolvedPriceList | null> {
  const version = await resolveEffectivePriceListVersion(db, priceListId, at);
  if (!version) return null;
  const entries = await db.restaurantPriceListEntry.findMany({
    where: { priceListVersionId: version.id },
    select: { id: true, productId: true, variantId: true, price: true },
  });
  return { version, entries };
}

export type ResolvePriceInput = {
  priceListId: string;
  productId: string;
  variantId?: string | null;
  at: Date;
};

/**
 * Resolve the single winning price for a (product, variant) pair from a price list
 * at instant `at`. Convenience over `resolveEffectiveEntries` + `pickEntry` for
 * one-off lookups; returns null when the list has no in-force version or no entry
 * for the product.
 */
export async function resolvePrice(
  db: ScopedDb,
  input: ResolvePriceInput
): Promise<{
  price: Prisma.Decimal;
  entry: ResolvedPriceEntry;
  version: ResolvedPriceListVersion;
} | null> {
  const resolved = await resolveEffectiveEntries(db, input.priceListId, input.at);
  if (!resolved) return null;
  const entry = pickEntry(resolved.entries, input.productId, input.variantId ?? null);
  if (!entry) return null;
  return { price: entry.price, entry, version: resolved.version };
}
