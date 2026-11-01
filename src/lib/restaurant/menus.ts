import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M3-L3 / C2 — brand-owned menu / section / item authoring (back-office server).
 *
 * A menu belongs to a brand; sections group items; a menu item scopes a canonical
 * (product, optional variant) pair into a section with optional menu-specific
 * naming. The canonical catalog is organization-owned and carries NO `branchId`
 * (C2) — a menu never copies product content, it only references catalog rows by
 * FK, and every referenced row is validated to be an in-scope canonical row so a
 * menu can never point at another organization's catalog (RLS scopes the lookup,
 * so a cross-org id simply resolves to "not found").
 *
 * Every function takes a tenant-scoped `ScopedDb`; `organizationId` is supplied by
 * the RLS default on each row and is never forged by the caller (C1). This module
 * owns menu structure only — publications, availability windows, price overrides
 * and the effective-menu read model live on the router/`menu-availability` side.
 */

export type MenuErrorReason =
  | 'INVALID'
  | 'BRAND_NOT_FOUND'
  | 'MENU_NOT_FOUND'
  | 'SECTION_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_MISMATCH'
  | 'COMBO_NOT_ORDERABLE'
  | 'MENU_IN_USE';

export class MenuError extends Error {
  constructor(
    message: string,
    readonly reason: MenuErrorReason
  ) {
    super(message);
    this.name = 'MenuError';
  }
}

// ── In-scope reference guards (RLS scopes every lookup to the caller's org) ────

/** A referenced brand must exist in the caller's organization. */
async function assertBrandInScope(db: ScopedDb, brandId: string): Promise<void> {
  const brand = await db.restaurantBrand.findUnique({
    where: { id: brandId },
    select: { id: true },
  });
  if (!brand) {
    throw new MenuError('The referenced brand does not exist.', 'BRAND_NOT_FOUND');
  }
}

/** A referenced menu must exist in the caller's organization. */
async function assertMenuInScope(db: ScopedDb, menuId: string): Promise<void> {
  const menu = await db.restaurantMenu.findUnique({ where: { id: menuId }, select: { id: true } });
  if (!menu) {
    throw new MenuError('The referenced menu does not exist.', 'MENU_NOT_FOUND');
  }
}

/**
 * A referenced product must exist in the caller's organization AND be orderable.
 *
 * COMBO products can be authored in the catalog (choice groups, component
 * options, price deltas), but the order flow does not yet accept component
 * selections, price combo deltas/cardinality, or consume component stock. Until
 * it does, a COMBO may not be placed on a menu — the only path by which a
 * product becomes orderable — so its configuration can never be silently
 * ignored at the till.
 */
async function assertProductInScope(db: ScopedDb, productId: string): Promise<void> {
  const product = await db.restaurantProduct.findUnique({
    where: { id: productId },
    select: { id: true, type: true },
  });
  if (!product) {
    throw new MenuError('The referenced product does not exist.', 'PRODUCT_NOT_FOUND');
  }
  if (product.type === 'COMBO') {
    throw new MenuError(
      'Combo products cannot be added to a menu until ordering supports combo selections.',
      'COMBO_NOT_ORDERABLE'
    );
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
    throw new MenuError('The referenced variant does not exist.', 'VARIANT_NOT_FOUND');
  }
  if (variant.productId !== productId) {
    throw new MenuError(
      'The referenced variant does not belong to the referenced product.',
      'VARIANT_MISMATCH'
    );
  }
}

function requireName(value: string, subject: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new MenuError(`A ${subject} requires a name.`, 'INVALID');
  }
  return name;
}

// ── Menu CRUD ─────────────────────────────────────────────────────────────────

export type CreateMenuInput = {
  brandId: string;
  name: string;
  nameLocalized?: Prisma.InputJsonValue | null;
  description?: string | null;
};

export async function createMenu(db: ScopedDb, input: CreateMenuInput) {
  const name = requireName(input.name, 'menu');
  await assertBrandInScope(db, input.brandId);
  return db.restaurantMenu.create({
    data: {
      brandId: input.brandId,
      name,
      nameLocalized: input.nameLocalized ?? undefined,
      description: input.description ?? null,
    },
  });
}

export type UpdateMenuInput = {
  name?: string;
  nameLocalized?: Prisma.InputJsonValue | null;
  description?: string | null;
};

/**
 * Partial update of a menu's own fields (a menu is not re-pointed to another
 * brand here — that is an unusual operation left out of the minimal CRUD). A
 * field absent from `patch` is left untouched.
 */
export async function updateMenu(db: ScopedDb, id: string, patch: UpdateMenuInput) {
  const existing = await db.restaurantMenu.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new MenuError('The menu does not exist.', 'MENU_NOT_FOUND');
  }
  const data: Prisma.RestaurantMenuUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'menu');
  if (patch.nameLocalized !== undefined) {
    data.nameLocalized = patch.nameLocalized ?? Prisma.DbNull;
  }
  if (patch.description !== undefined) data.description = patch.description;
  return db.restaurantMenu.update({ where: { id }, data });
}

/**
 * Delete a menu (cascading its sections/items). Refused while a non-RETIRED
 * publication still references the menu: deleting it would cascade a live
 * publication — and its windows, exceptions and overrides — away silently. Retire
 * the publication first. RETIRED publications no longer block deletion.
 */
export async function deleteMenu(db: ScopedDb, id: string) {
  const existing = await db.restaurantMenu.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new MenuError('The menu does not exist.', 'MENU_NOT_FOUND');
  }
  const livePublication = await db.restaurantBranchMenuPublication.findFirst({
    where: { menuId: id, status: { not: 'RETIRED' } },
    select: { id: true },
  });
  if (livePublication) {
    throw new MenuError(
      'The menu is still published to a branch; retire the publication before deleting it.',
      'MENU_IN_USE'
    );
  }
  await db.restaurantMenu.delete({ where: { id } });
  return { id };
}

// ── Section CRUD ──────────────────────────────────────────────────────────────

export type CreateSectionInput = {
  menuId: string;
  name: string;
  nameLocalized?: Prisma.InputJsonValue | null;
  sortOrder?: number;
};

export async function createMenuSection(db: ScopedDb, input: CreateSectionInput) {
  const name = requireName(input.name, 'section');
  await assertMenuInScope(db, input.menuId);
  return db.restaurantMenuSection.create({
    data: {
      menuId: input.menuId,
      name,
      nameLocalized: input.nameLocalized ?? undefined,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateSectionInput = {
  name?: string;
  nameLocalized?: Prisma.InputJsonValue | null;
  sortOrder?: number;
};

export async function updateMenuSection(db: ScopedDb, id: string, patch: UpdateSectionInput) {
  const existing = await db.restaurantMenuSection.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new MenuError('The menu section does not exist.', 'SECTION_NOT_FOUND');
  }
  const data: Prisma.RestaurantMenuSectionUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'section');
  if (patch.nameLocalized !== undefined) {
    data.nameLocalized = patch.nameLocalized ?? Prisma.DbNull;
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantMenuSection.update({ where: { id }, data });
}

export async function deleteMenuSection(db: ScopedDb, id: string) {
  const existing = await db.restaurantMenuSection.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new MenuError('The menu section does not exist.', 'SECTION_NOT_FOUND');
  }
  await db.restaurantMenuSection.delete({ where: { id } });
  return { id };
}

// ── Menu item CRUD ────────────────────────────────────────────────────────────

export type CreateMenuItemInput = {
  sectionId: string;
  productId: string;
  variantId?: string | null;
  displayName?: string | null;
  nameLocalized?: Prisma.InputJsonValue | null;
  sortOrder?: number;
};

/**
 * Add a menu item scoping a canonical (product, optional variant) pair into a
 * section. The section, product and — when given — the variant are all validated
 * as in-scope canonical rows, and the variant must belong to the product
 * (C2: the item references catalog rows by FK, it never carries their content).
 */
export async function createMenuItem(db: ScopedDb, input: CreateMenuItemInput) {
  const section = await db.restaurantMenuSection.findUnique({
    where: { id: input.sectionId },
    select: { id: true },
  });
  if (!section) {
    throw new MenuError('The menu section does not exist.', 'SECTION_NOT_FOUND');
  }
  const variantId = input.variantId ?? null;
  await assertProductInScope(db, input.productId);
  if (variantId) await assertVariantMatchesProduct(db, variantId, input.productId);

  return db.restaurantMenuItem.create({
    data: {
      sectionId: input.sectionId,
      productId: input.productId,
      variantId,
      displayName: input.displayName ?? null,
      nameLocalized: input.nameLocalized ?? undefined,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateMenuItemInput = {
  displayName?: string | null;
  nameLocalized?: Prisma.InputJsonValue | null;
  sortOrder?: number;
};

/**
 * Update a menu item's presentation only (display name / localized names / sort
 * order). The underlying (product, variant) reference is intentionally NOT
 * re-pointed here — a menu item is a thin scoping row, so changing what it points
 * at is done by removing it and adding a new one, which keeps the referential
 * validation in exactly one place (`createMenuItem`).
 */
export async function updateMenuItem(db: ScopedDb, id: string, patch: UpdateMenuItemInput) {
  const existing = await db.restaurantMenuItem.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new MenuError('The menu item does not exist.', 'ITEM_NOT_FOUND');
  }
  const data: Prisma.RestaurantMenuItemUncheckedUpdateInput = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.nameLocalized !== undefined) {
    data.nameLocalized = patch.nameLocalized ?? Prisma.DbNull;
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantMenuItem.update({ where: { id }, data });
}

export async function deleteMenuItem(db: ScopedDb, id: string) {
  const existing = await db.restaurantMenuItem.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new MenuError('The menu item does not exist.', 'ITEM_NOT_FOUND');
  }
  await db.restaurantMenuItem.delete({ where: { id } });
  return { id };
}
