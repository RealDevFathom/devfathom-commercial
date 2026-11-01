import 'server-only';

import { catalogOrganizationId } from './catalog-scope';

import { Prisma } from '@/generated/prisma/client';
import type { RestaurantBrandStatus, RestaurantProductStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M3-L2 / §6 — the canonical catalog server (brands, categories, products,
 * variants, modifiers, combos, product-allergen links).
 *
 * Every function takes a tenant-scoped `ScopedDb`: `organizationId` is supplied
 * by the trusted transaction scope on each row and is never forged by the caller (C1). This
 * module owns the *canonical* catalog only — the organization-wide product
 * definitions that branches later publish. Two binding invariants shape it:
 *
 *  - **C2 (structural shadow-copy prevention):** no canonical table carries a
 *    `branchId`. None of the inputs here accept one, and there is no column to
 *    write it to; branch linkage exists only on the publication side (L3).
 *  - **C6 (one default brand per organization):** a partial unique index
 *    (`WHERE isDefault`) enforces it in the database; `ensureDefaultBrand` is the
 *    lazy, idempotent path that materialises it — no onboarding edit, no SQL
 *    backfill. `restaurant.brands.max` is enforced only for *additional* brands.
 *
 * Referenced canonical rows are archived (status → ARCHIVED), never hard-deleted,
 * so historical orders/menus keep resolving; the database `RESTRICT` foreign keys
 * are the backstop and their violations are surfaced as friendly domain errors.
 */

export type CatalogErrorReason =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'BRAND_LIMIT_REACHED'
  | 'DEFAULT_BRAND_PROTECTED'
  | 'CATEGORY_CYCLE'
  | 'NOT_A_COMBO'
  | 'ALREADY_ATTACHED'
  | 'REFERENCED';

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly reason: CatalogErrorReason
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** A locale-keyed companion for a customer-facing string (D20). */
export type LocalizedField = Record<string, string>;

/**
 * Normalise an optional localized-JSON field for a Prisma write. `undefined`
 * leaves the column untouched (partial update); an explicit `null` clears it to
 * SQL NULL (`Prisma.DbNull`, not the JSON literal `null`); an object is stored
 * verbatim so it round-trips unchanged.
 */
function localizedWrite(
  value: LocalizedField | null | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/** A required, trimmed name; blank is a domain error, not a silent empty row. */
function requireName(value: string, label = 'name'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CatalogError(`A ${label} is required.`, 'INVALID');
  }
  return trimmed;
}

/** Build a Decimal from a validated decimal string, keeping money float-free (C4). */
function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

// ── Brands (C6) ─────────────────────────────────────────────────────────────

/**
 * Idempotently ensure the organization's single default brand exists and return
 * it (C6). If a default already exists it is returned unchanged; otherwise one is
 * created with `isDefault: true`. The create is race-safe: a concurrent caller
 * that wins the partial unique index makes this one re-read and return the
 * winner rather than surfacing the constraint violation. The default brand is the
 * baseline entitlement every restaurant receives, so it is *not* counted against
 * `restaurant.brands.max`.
 */
export async function ensureDefaultBrand(db: ScopedDb, name = 'Default Brand') {
  const organizationId = await catalogOrganizationId(db);
  const existing = await db.restaurantBrand.findFirst({
    where: { organizationId, isDefault: true },
  });
  if (existing) return existing;
  try {
    return await db.restaurantBrand.create({
      data: { organizationId, name: requireName(name, 'brand name'), isDefault: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await db.restaurantBrand.findFirst({
        where: { organizationId, isDefault: true },
      });
      if (raced) return raced;
    }
    throw err;
  }
}

export type CreateBrandInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
};

/**
 * Create an additional (non-default) brand, enforcing `restaurant.brands.max`
 * (C6). The limit counts ACTIVE brands — the default plus any others — so an
 * organization on a one-brand package is capped at its default alone. New brands
 * are never created as the default; use `setDefaultBrand` to move the flag.
 */
export async function createBrand(db: ScopedDb, input: CreateBrandInput, brandsMax: number) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'brand name');
  const activeCount = await db.restaurantBrand.count({
    where: { organizationId, status: 'ACTIVE' },
  });
  if (activeCount >= brandsMax) {
    throw new CatalogError(
      `This plan allows at most ${brandsMax} active brand(s).`,
      'BRAND_LIMIT_REACHED'
    );
  }
  return db.restaurantBrand.create({
    data: { organizationId, name, nameLocalized: localizedWrite(input.nameLocalized) },
  });
}

export type UpdateBrandInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
};

export async function updateBrand(db: ScopedDb, id: string, patch: UpdateBrandInput) {
  const organizationId = await catalogOrganizationId(db);
  await requireBrand(db, id);
  const data: Prisma.RestaurantBrandUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'brand name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  return db.restaurantBrand.update({ where: { organizationId, id }, data });
}

/**
 * Move the single default flag to `id` atomically (C6). The prior default is
 * cleared and the target set inside one transaction so the partial unique index
 * never sees two defaults. The target must exist and be ACTIVE — an archived
 * brand cannot be the default.
 */
export async function setDefaultBrand(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const brand = await requireBrand(db, id);
  if (brand.status !== 'ACTIVE') {
    throw new CatalogError('An archived brand cannot be made the default.', 'INVALID');
  }
  return db.$transaction(async (tx) => {
    await tx.restaurantBrand.updateMany({
      where: { organizationId, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.restaurantBrand.update({ where: { organizationId, id }, data: { isDefault: true } });
  });
}

/**
 * Archive or reactivate a brand. The default brand cannot be archived — the
 * organization must first promote another brand to default (keeps the C6
 * invariant meaningful: the default is always an ACTIVE brand).
 */
export async function setBrandStatus(db: ScopedDb, id: string, status: RestaurantBrandStatus) {
  const organizationId = await catalogOrganizationId(db);
  const brand = await requireBrand(db, id);
  if (status === 'ARCHIVED' && brand.isDefault) {
    throw new CatalogError(
      'The default brand cannot be archived; set another brand as default first.',
      'DEFAULT_BRAND_PROTECTED'
    );
  }
  return db.restaurantBrand.update({ where: { organizationId, id }, data: { status } });
}

async function requireBrand(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const brand = await db.restaurantBrand.findUnique({
    where: { organizationId, id },
    select: { id: true, status: true, isDefault: true },
  });
  if (!brand) throw new CatalogError('Brand not found.', 'NOT_FOUND');
  return brand;
}

// ── Categories (self-referencing hierarchy) ─────────────────────────────────

export type CreateCategoryInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
  parentId?: string | null;
  sortOrder?: number;
};

export async function createCategory(db: ScopedDb, input: CreateCategoryInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'category name');
  if (input.parentId) await requireCategory(db, input.parentId);
  return db.restaurantCategory.create({
    data: {
      organizationId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateCategoryInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  parentId?: string | null;
  sortOrder?: number;
};

/**
 * Partial category update including reparenting. Reparenting is cycle-guarded: a
 * category may not become its own ancestor/descendant, which would create an
 * unresolvable tree. A self-parent and any path back to `id` are rejected.
 */
export async function updateCategory(db: ScopedDb, id: string, patch: UpdateCategoryInput) {
  const organizationId = await catalogOrganizationId(db);
  await requireCategory(db, id);
  const data: Prisma.RestaurantCategoryUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'category name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.parentId !== undefined) {
    if (patch.parentId) {
      if (patch.parentId === id) {
        throw new CatalogError('A category cannot be its own parent.', 'CATEGORY_CYCLE');
      }
      await requireCategory(db, patch.parentId);
      await assertNoCategoryCycle(db, id, patch.parentId);
    }
    data.parentId = patch.parentId;
  }
  return db.restaurantCategory.update({ where: { organizationId, id }, data });
}

/**
 * Delete a category. Children detach (parentId → null) and products detach
 * (categoryId → null) via the schema `SetNull` foreign keys; no product or
 * subtree is destroyed. Categories are not versioned/referenced content, so a
 * plain delete is safe here (unlike products, which are archived).
 */
export async function deleteCategory(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireCategory(db, id);
  await db.restaurantCategory.delete({ where: { organizationId, id } });
}

/** Walk from `fromParentId` up the parent chain; reaching `childId` is a cycle. */
async function assertNoCategoryCycle(db: ScopedDb, childId: string, fromParentId: string) {
  const organizationId = await catalogOrganizationId(db);
  let cursor: string | null = fromParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === childId) {
      throw new CatalogError('Reparenting there would create a category cycle.', 'CATEGORY_CYCLE');
    }
    if (seen.has(cursor)) break; // pre-existing cycle guard — never loop forever
    seen.add(cursor);
    const parent: { parentId: string | null } | null = await db.restaurantCategory.findUnique({
      where: { organizationId, id: cursor },
      select: { parentId: true },
    });
    cursor = parent?.parentId ?? null;
  }
}

async function requireCategory(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const category = await db.restaurantCategory.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!category) throw new CatalogError('Category not found.', 'NOT_FOUND');
  return category;
}

// ── Products & variants ─────────────────────────────────────────────────────

export type ProductType = 'ITEM' | 'COMBO';

export type CreateProductInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
  description?: string | null;
  descriptionLocalized?: LocalizedField | null;
  type?: ProductType;
  categoryId?: string | null;
  sortOrder?: number;
};

export async function createProduct(db: ScopedDb, input: CreateProductInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'product name');
  if (input.categoryId) await requireCategory(db, input.categoryId);
  return db.restaurantProduct.create({
    data: {
      organizationId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      description: input.description ?? null,
      descriptionLocalized: localizedWrite(input.descriptionLocalized),
      type: input.type ?? 'ITEM',
      categoryId: input.categoryId ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateProductInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  description?: string | null;
  descriptionLocalized?: LocalizedField | null;
  categoryId?: string | null;
  sortOrder?: number;
};

export async function updateProduct(db: ScopedDb, id: string, patch: UpdateProductInput) {
  const organizationId = await catalogOrganizationId(db);
  await requireProduct(db, id);
  const data: Prisma.RestaurantProductUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'product name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.descriptionLocalized !== undefined) {
    data.descriptionLocalized = localizedWrite(patch.descriptionLocalized);
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.categoryId !== undefined) {
    if (patch.categoryId) await requireCategory(db, patch.categoryId);
    data.categoryId = patch.categoryId;
  }
  return db.restaurantProduct.update({ where: { organizationId, id }, data });
}

/**
 * Archive or reactivate a product. Products are archived, never hard-deleted,
 * once they may be referenced by menus/orders/recipes — archival preserves the
 * canonical row so historical references keep resolving.
 */
export async function setProductStatus(db: ScopedDb, id: string, status: RestaurantProductStatus) {
  const organizationId = await catalogOrganizationId(db);
  await requireProduct(db, id);
  return db.restaurantProduct.update({ where: { organizationId, id }, data: { status } });
}

export type CreateVariantInput = {
  productId: string;
  name: string;
  nameLocalized?: LocalizedField | null;
  sortOrder?: number;
};

export async function createVariant(db: ScopedDb, input: CreateVariantInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'variant name');
  await requireProduct(db, input.productId);
  return db.restaurantProductVariant.create({
    data: {
      organizationId,
      productId: input.productId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateVariantInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  sortOrder?: number;
};

export async function updateVariant(db: ScopedDb, id: string, patch: UpdateVariantInput) {
  const organizationId = await catalogOrganizationId(db);
  const variant = await db.restaurantProductVariant.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!variant) throw new CatalogError('Variant not found.', 'NOT_FOUND');
  const data: Prisma.RestaurantProductVariantUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'variant name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantProductVariant.update({ where: { organizationId, id }, data });
}

/**
 * Delete a variant only when it is not referenced. Variants carry no status
 * column, so "archival, not deletion, once referenced" is enforced by pre-
 * checking the hard (`RESTRICT`) references — price-list entries and menu items —
 * before deleting; a referenced variant is rejected as `REFERENCED`. Combo and
 * recipe references use `SetNull` and simply detach.
 */
export async function deleteVariant(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const variant = await db.restaurantProductVariant.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!variant) throw new CatalogError('Variant not found.', 'NOT_FOUND');
  const [priceEntries, menuItems] = await Promise.all([
    db.restaurantPriceListEntry.count({ where: { organizationId, variantId: id } }),
    db.restaurantMenuItem.count({ where: { organizationId, variantId: id } }),
  ]);
  if (priceEntries > 0 || menuItems > 0) {
    throw new CatalogError(
      'This variant is referenced by a price list or menu and cannot be deleted; remove those references first.',
      'REFERENCED'
    );
  }
  await db.restaurantProductVariant.delete({ where: { organizationId, id } });
}

async function requireProduct(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const product = await db.restaurantProduct.findUnique({
    where: { organizationId, id },
    select: { id: true, type: true },
  });
  if (!product) throw new CatalogError('Product not found.', 'NOT_FOUND');
  return product;
}

// ── Modifier groups, options, and product attachment ────────────────────────

export type CreateModifierGroupInput = {
  name: string;
  nameLocalized?: LocalizedField | null;
  minSelect?: number;
  maxSelect?: number | null;
};

/** min/max selection must be coherent: min >= 0 and, when bounded, max >= min. */
function assertSelectionBounds(minSelect: number, maxSelect: number | null | undefined) {
  if (minSelect < 0) throw new CatalogError('minSelect cannot be negative.', 'INVALID');
  if (maxSelect != null && maxSelect < minSelect) {
    throw new CatalogError('maxSelect cannot be less than minSelect.', 'INVALID');
  }
}

export async function createModifierGroup(db: ScopedDb, input: CreateModifierGroupInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'modifier group name');
  const minSelect = input.minSelect ?? 0;
  assertSelectionBounds(minSelect, input.maxSelect);
  return db.restaurantModifierGroup.create({
    data: {
      organizationId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      minSelect,
      maxSelect: input.maxSelect ?? null,
    },
  });
}

export type UpdateModifierGroupInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  minSelect?: number;
  maxSelect?: number | null;
};

export async function updateModifierGroup(
  db: ScopedDb,
  id: string,
  patch: UpdateModifierGroupInput
) {
  const organizationId = await catalogOrganizationId(db);
  const group = await db.restaurantModifierGroup.findUnique({
    where: { organizationId, id },
    select: { minSelect: true, maxSelect: true },
  });
  if (!group) throw new CatalogError('Modifier group not found.', 'NOT_FOUND');
  const minSelect = patch.minSelect ?? group.minSelect;
  const maxSelect = patch.maxSelect !== undefined ? patch.maxSelect : group.maxSelect;
  assertSelectionBounds(minSelect, maxSelect);
  const data: Prisma.RestaurantModifierGroupUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'modifier group name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.minSelect !== undefined) data.minSelect = patch.minSelect;
  if (patch.maxSelect !== undefined) data.maxSelect = patch.maxSelect;
  return db.restaurantModifierGroup.update({ where: { organizationId, id }, data });
}

export async function deleteModifierGroup(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const group = await db.restaurantModifierGroup.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!group) throw new CatalogError('Modifier group not found.', 'NOT_FOUND');
  // Options and product attachments cascade (schema onDelete: Cascade).
  await db.restaurantModifierGroup.delete({ where: { organizationId, id } });
}

export type CreateModifierOptionInput = {
  modifierGroupId: string;
  name: string;
  nameLocalized?: LocalizedField | null;
  priceDelta?: string;
  sortOrder?: number;
};

export async function createModifierOption(db: ScopedDb, input: CreateModifierOptionInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'modifier option name');
  const group = await db.restaurantModifierGroup.findUnique({
    where: { organizationId, id: input.modifierGroupId },
    select: { id: true },
  });
  if (!group) throw new CatalogError('Modifier group not found.', 'NOT_FOUND');
  return db.restaurantModifierOption.create({
    data: {
      organizationId,
      modifierGroupId: input.modifierGroupId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      priceDelta: decimal(input.priceDelta ?? '0'),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateModifierOptionInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  priceDelta?: string;
  sortOrder?: number;
};

export async function updateModifierOption(
  db: ScopedDb,
  id: string,
  patch: UpdateModifierOptionInput
) {
  const organizationId = await catalogOrganizationId(db);
  const option = await db.restaurantModifierOption.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!option) throw new CatalogError('Modifier option not found.', 'NOT_FOUND');
  const data: Prisma.RestaurantModifierOptionUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'modifier option name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.priceDelta !== undefined) data.priceDelta = decimal(patch.priceDelta);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantModifierOption.update({ where: { organizationId, id }, data });
}

export async function deleteModifierOption(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const option = await db.restaurantModifierOption.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!option) throw new CatalogError('Modifier option not found.', 'NOT_FOUND');
  await db.restaurantModifierOption.delete({ where: { organizationId, id } });
}

/**
 * Attach a modifier group to a product. The (product, group) pair is unique; a
 * duplicate attachment is a friendly `ALREADY_ATTACHED` rather than a raw unique
 * violation. Both endpoints are asserted in-scope first.
 */
export async function attachModifierGroup(
  db: ScopedDb,
  productId: string,
  modifierGroupId: string,
  sortOrder = 0
) {
  const organizationId = await catalogOrganizationId(db);
  await requireProduct(db, productId);
  const group = await db.restaurantModifierGroup.findUnique({
    where: { organizationId, id: modifierGroupId },
    select: { id: true },
  });
  if (!group) throw new CatalogError('Modifier group not found.', 'NOT_FOUND');
  const existing = await db.restaurantProductModifierGroup.findUnique({
    where: { organizationId, productId_modifierGroupId: { productId, modifierGroupId } },
    select: { id: true },
  });
  if (existing) {
    throw new CatalogError('That modifier group is already attached.', 'ALREADY_ATTACHED');
  }
  return db.restaurantProductModifierGroup.create({
    data: { organizationId, productId, modifierGroupId, sortOrder },
  });
}

export async function detachModifierGroup(
  db: ScopedDb,
  productId: string,
  modifierGroupId: string
) {
  const organizationId = await catalogOrganizationId(db);
  const attachment = await db.restaurantProductModifierGroup.findUnique({
    where: { organizationId, productId_modifierGroupId: { productId, modifierGroupId } },
    select: { id: true },
  });
  if (!attachment) throw new CatalogError('That attachment does not exist.', 'NOT_FOUND');
  await db.restaurantProductModifierGroup.delete({ where: { organizationId, id: attachment.id } });
}

// ── Combo component seam (A08 — schema + minimal CRUD only) ──────────────────

export type CreateComboGroupInput = {
  comboProductId: string;
  name: string;
  nameLocalized?: LocalizedField | null;
  minChoose?: number;
  maxChoose?: number | null;
  sortOrder?: number;
};

/**
 * Create a choose-group on a COMBO product. The parent product must have
 * `type = COMBO`; attaching a combo group to a plain ITEM is rejected as
 * `NOT_A_COMBO`.
 */
export async function createComboGroup(db: ScopedDb, input: CreateComboGroupInput) {
  const organizationId = await catalogOrganizationId(db);
  const name = requireName(input.name, 'combo group name');
  const product = await requireProduct(db, input.comboProductId);
  if (product.type !== 'COMBO') {
    throw new CatalogError('Combo groups may only be added to COMBO products.', 'NOT_A_COMBO');
  }
  const minChoose = input.minChoose ?? 1;
  assertSelectionBounds(minChoose, input.maxChoose);
  return db.restaurantComboComponentGroup.create({
    data: {
      organizationId,
      comboProductId: input.comboProductId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      minChoose,
      maxChoose: input.maxChoose ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateComboGroupInput = {
  name?: string;
  nameLocalized?: LocalizedField | null;
  minChoose?: number;
  maxChoose?: number | null;
  sortOrder?: number;
};

export async function updateComboGroup(db: ScopedDb, id: string, patch: UpdateComboGroupInput) {
  const organizationId = await catalogOrganizationId(db);
  const group = await db.restaurantComboComponentGroup.findUnique({
    where: { organizationId, id },
    select: { minChoose: true, maxChoose: true },
  });
  if (!group) throw new CatalogError('Combo group not found.', 'NOT_FOUND');
  const minChoose = patch.minChoose ?? group.minChoose;
  const maxChoose = patch.maxChoose !== undefined ? patch.maxChoose : group.maxChoose;
  assertSelectionBounds(minChoose, maxChoose);
  const data: Prisma.RestaurantComboComponentGroupUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'combo group name');
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.minChoose !== undefined) data.minChoose = patch.minChoose;
  if (patch.maxChoose !== undefined) data.maxChoose = patch.maxChoose;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantComboComponentGroup.update({ where: { organizationId, id }, data });
}

export async function deleteComboGroup(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const group = await db.restaurantComboComponentGroup.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!group) throw new CatalogError('Combo group not found.', 'NOT_FOUND');
  await db.restaurantComboComponentGroup.delete({ where: { organizationId, id } });
}

export type CreateComboOptionInput = {
  componentGroupId: string;
  productId: string;
  variantId?: string | null;
  priceDelta?: string;
  sortOrder?: number;
};

/** Add a selectable component (a product, optional variant) to a combo group. */
export async function createComboOption(db: ScopedDb, input: CreateComboOptionInput) {
  const organizationId = await catalogOrganizationId(db);
  const group = await db.restaurantComboComponentGroup.findUnique({
    where: { organizationId, id: input.componentGroupId },
    select: { id: true },
  });
  if (!group) throw new CatalogError('Combo group not found.', 'NOT_FOUND');
  await requireProduct(db, input.productId);
  if (input.variantId) await requireVariantOfProduct(db, input.variantId, input.productId);
  return db.restaurantComboComponentOption.create({
    data: {
      organizationId,
      componentGroupId: input.componentGroupId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      priceDelta: decimal(input.priceDelta ?? '0'),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateComboOptionInput = {
  priceDelta?: string;
  sortOrder?: number;
};

export async function updateComboOption(db: ScopedDb, id: string, patch: UpdateComboOptionInput) {
  const organizationId = await catalogOrganizationId(db);
  const option = await db.restaurantComboComponentOption.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!option) throw new CatalogError('Combo option not found.', 'NOT_FOUND');
  const data: Prisma.RestaurantComboComponentOptionUncheckedUpdateInput = {};
  if (patch.priceDelta !== undefined) data.priceDelta = decimal(patch.priceDelta);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantComboComponentOption.update({ where: { organizationId, id }, data });
}

export async function deleteComboOption(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const option = await db.restaurantComboComponentOption.findUnique({
    where: { organizationId, id },
    select: { id: true },
  });
  if (!option) throw new CatalogError('Combo option not found.', 'NOT_FOUND');
  await db.restaurantComboComponentOption.delete({ where: { organizationId, id } });
}

/** A referenced variant must belong to the referenced product (in-scope). */
async function requireVariantOfProduct(db: ScopedDb, variantId: string, productId: string) {
  const organizationId = await catalogOrganizationId(db);
  const variant = await db.restaurantProductVariant.findUnique({
    where: { organizationId, id: variantId },
    select: { productId: true },
  });
  if (!variant) throw new CatalogError('Variant not found.', 'NOT_FOUND');
  if (variant.productId !== productId) {
    throw new CatalogError('That variant does not belong to the given product.', 'INVALID');
  }
}

// ── Product ↔ allergen attachment ───────────────────────────────────────────

/**
 * Declare an allergen on a product. The (product, allergen) pair is unique; a
 * duplicate is a friendly `ALREADY_ATTACHED`. The allergen catalog itself is
 * managed in `recipes.ts`; this only links an existing allergen to a product.
 */
export async function attachProductAllergen(db: ScopedDb, productId: string, allergenId: string) {
  const organizationId = await catalogOrganizationId(db);
  await requireProduct(db, productId);
  const allergen = await db.restaurantAllergen.findUnique({
    where: { organizationId, id: allergenId },
    select: { id: true },
  });
  if (!allergen) throw new CatalogError('Allergen not found.', 'NOT_FOUND');
  const existing = await db.restaurantProductAllergen.findUnique({
    where: { organizationId, productId_allergenId: { productId, allergenId } },
    select: { id: true },
  });
  if (existing) {
    throw new CatalogError(
      'That allergen is already declared on this product.',
      'ALREADY_ATTACHED'
    );
  }
  return db.restaurantProductAllergen.create({ data: { organizationId, productId, allergenId } });
}

export async function detachProductAllergen(db: ScopedDb, productId: string, allergenId: string) {
  const organizationId = await catalogOrganizationId(db);
  const link = await db.restaurantProductAllergen.findUnique({
    where: { organizationId, productId_allergenId: { productId, allergenId } },
    select: { id: true },
  });
  if (!link) throw new CatalogError('That allergen is not declared on this product.', 'NOT_FOUND');
  await db.restaurantProductAllergen.delete({ where: { organizationId, id: link.id } });
}

// ── Read models (catalog console read-contract) ───────────────────────────────
// Capability-gated (menu:read) list/read surfaces the brands/catalog consoles
// need. All use explicit organization predicates in addition to RLS (C1); none
// carry monetary Decimal fields at the returned level, so no C4 serialization is
// required here (recipe/costing reads that do are serialized at the router).

/** All brands for the organization, default brand first then alphabetical. */
export async function listBrands(db: ScopedDb) {
  const organizationId = await catalogOrganizationId(db);
  return db.restaurantBrand.findMany({
    where: { organizationId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });
}

/** A single brand by id (any status). Missing id is NOT_FOUND. */
export async function getBrand(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const brand = await db.restaurantBrand.findUnique({ where: { organizationId, id } });
  if (!brand) throw new CatalogError('Brand not found.', 'NOT_FOUND');
  return brand;
}

/** All catalog categories, ordered for tree display (sortOrder then name). */
export async function listCategories(db: ScopedDb) {
  const organizationId = await catalogOrganizationId(db);
  return db.restaurantCategory.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/**
 * The relations the catalog console renders alongside a product: its category,
 * its variants, and the modifier groups attached to it. Modifier *options*
 * (which carry a Decimal `priceDelta`) are intentionally not expanded here — a
 * console fetches those per group — so product reads stay Decimal-free.
 */
const productConsoleInclude = (organizationId: string) =>
  ({
    category: { where: { organizationId } },
    variants: { where: { organizationId }, orderBy: { sortOrder: 'asc' } },
    modifierGroups: {
      where: { organizationId, modifierGroup: { organizationId } },
      orderBy: { sortOrder: 'asc' },
      include: { modifierGroup: true },
    },
  }) satisfies Prisma.RestaurantProductInclude;

export type ListProductsFilter = {
  categoryId?: string | null;
  status?: RestaurantProductStatus;
  type?: ProductType;
};

/** Canonical products (with category/variants/modifier groups) for the console. */
export async function listProducts(db: ScopedDb, filter: ListProductsFilter = {}) {
  const organizationId = await catalogOrganizationId(db);
  const where: Prisma.RestaurantProductWhereInput = { organizationId };
  if (filter.categoryId !== undefined) where.categoryId = filter.categoryId;
  if (filter.status !== undefined) where.status = filter.status;
  if (filter.type !== undefined) where.type = filter.type;
  return db.restaurantProduct.findMany({
    where,
    include: productConsoleInclude(organizationId),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/** A single product with its category, variants, and attached modifier groups. */
export async function getProduct(db: ScopedDb, id: string) {
  const organizationId = await catalogOrganizationId(db);
  const product = await db.restaurantProduct.findUnique({
    where: { organizationId, id },
    include: productConsoleInclude(organizationId),
  });
  if (!product) throw new CatalogError('Product not found.', 'NOT_FOUND');
  return product;
}
