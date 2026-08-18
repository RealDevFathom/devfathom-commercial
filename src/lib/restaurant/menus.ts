import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M3-L3 / §6.3 / C2 — brand-owned menu structure: menus, sections, and items.
 *
 * A menu belongs to a brand and owns ordered sections; a section owns items;
 * an item scopes a canonical product (and optional variant) into the menu. The
 * canonical catalog is organization-owned and carries NO branchId (C2) — branch
 * linkage lives only on publications (see `restaurant-menus.ts`), so nothing here
 * knows about branches. An item's product/variant reference is validated to be an
 * in-scope canonical row before it is written, so a menu can never point at
 * another organization's catalog (RLS scopes the lookups; a friendly domain error
 * replaces the raw miss).
 *
 * Every function takes a tenant-scoped `ScopedDb`; `organizationId` is filled by
 * the RLS default on each row and is never forged by the caller (C1).
 */

export type MenuErrorReason =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'BRAND_NOT_FOUND'
  | 'MENU_NOT_FOUND'
  | 'SECTION_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_ARCHIVED'
  | 'VARIANT_NOT_FOUND'
  | 'VARIANT_MISMATCH'
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

/** A localized-name JSON value, or `null` to clear it. */
export type LocalizedInput = Prisma.InputJsonValue | null;

/** Map an optional localized-name patch to a Prisma Json write (DB NULL to clear). */
function localizedWrite(value: LocalizedInput | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : value;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new MenuError('A name is required.', 'INVALID');
  }
  return trimmed;
}

// ── In-scope reference guards ────────────────────────────────────────────────

async function assertBrandInScope(db: ScopedDb, brandId: string): Promise<void> {
  const brand = await db.restaurantBrand.findUnique({ where: { id: brandId }, select: { id: true } });
  if (!brand) {
    throw new MenuError('The referenced brand does not exist.', 'BRAND_NOT_FOUND');
  }
}

async function assertMenuInScope(db: ScopedDb, menuId: string): Promise<void> {
  const menu = await db.restaurantMenu.findUnique({ where: { id: menuId }, select: { id: true } });
  if (!menu) {
    throw new MenuError('The referenced menu does not exist.', 'MENU_NOT_FOUND');
  }
}

async function assertSectionInScope(db: ScopedDb, sectionId: string): Promise<void> {
  const section = await db.restaurantMenuSection.findUnique({
    where: { id: sectionId },
    select: { id: true },
  });
  if (!section) {
    throw new MenuError('The referenced section does not exist.', 'SECTION_NOT_FOUND');
  }
}

/** A menu item may only reference an in-scope, non-archived canonical product. */
async function assertProductUsable(db: ScopedDb, productId: string): Promise<void> {
  const product = await db.restaurantProduct.findUnique({
    where: { id: productId },
    select: { id: true, status: true },
  });
  if (!product) {
    throw new MenuError('The referenced product does not exist.', 'PRODUCT_NOT_FOUND');
  }
  if (product.status === 'ARCHIVED') {
    throw new MenuError('The referenced product is archived.', 'PRODUCT_ARCHIVED');
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

// ── Menus ────────────────────────────────────────────────────────────────────

export type CreateMenuInput = {
  brandId: string;
  name: string;
  nameLocalized?: LocalizedInput;
  description?: string | null;
};

export async function createMenu(db: ScopedDb, input: CreateMenuInput) {
  const name = requireName(input.name);
  await assertBrandInScope(db, input.brandId);
  return db.restaurantMenu.create({
    data: {
      brandId: input.brandId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      description: input.description ?? null,
    },
  });
}

export type UpdateMenuInput = {
  name?: string;
  nameLocalized?: LocalizedInput;
  description?: string | null;
};

export async function updateMenu(db: ScopedDb, id: string, patch: UpdateMenuInput) {
  await assertMenuInScope(db, id);
  const data: Prisma.RestaurantMenuUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name);
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.description !== undefined) data.description = patch.description;
  return db.restaurantMenu.update({ where: { id }, data });
}

/**
 * Delete a menu. Refused while any PUBLISHED or RETIRED publication references it,
 * because deleting the menu cascades those publications away and a retired
 * publication is history that must stay readable (GOV-2). DRAFT publications carry
 * no history and cascade with the menu.
 */
export async function deleteMenu(db: ScopedDb, id: string) {
  await assertMenuInScope(db, id);
  const published = await db.restaurantBranchMenuPublication.findFirst({
    where: { menuId: id, status: { in: ['PUBLISHED', 'RETIRED'] } },
    select: { id: true },
  });
  if (published) {
    throw new MenuError(
      'The menu has published or retired publications and cannot be deleted; retire and remove them first.',
      'MENU_IN_USE'
    );
  }
  await db.restaurantMenu.delete({ where: { id } });
  return { id };
}

// ── Sections ──────────────────────────────────────────────────────────────────

export type CreateSectionInput = {
  menuId: string;
  name: string;
  nameLocalized?: LocalizedInput;
  sortOrder?: number;
};

export async function createMenuSection(db: ScopedDb, input: CreateSectionInput) {
  const name = requireName(input.name);
  await assertMenuInScope(db, input.menuId);
  return db.restaurantMenuSection.create({
    data: {
      menuId: input.menuId,
      name,
      nameLocalized: localizedWrite(input.nameLocalized),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateSectionInput = {
  name?: string;
  nameLocalized?: LocalizedInput;
  sortOrder?: number;
};

export async function updateMenuSection(db: ScopedDb, id: string, patch: UpdateSectionInput) {
  const existing = await db.restaurantMenuSection.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new MenuError('The section does not exist.', 'SECTION_NOT_FOUND');
  }
  const data: Prisma.RestaurantMenuSectionUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name);
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  return db.restaurantMenuSection.update({ where: { id }, data });
}

export async function deleteMenuSection(db: ScopedDb, id: string) {
  const existing = await db.restaurantMenuSection.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new MenuError('The section does not exist.', 'SECTION_NOT_FOUND');
  }
  await db.restaurantMenuSection.delete({ where: { id } });
  return { id };
}

// ── Items ─────────────────────────────────────────────────────────────────────

export type CreateMenuItemInput = {
  sectionId: string;
  productId: string;
  variantId?: string | null;
  displayName?: string | null;
  nameLocalized?: LocalizedInput;
  sortOrder?: number;
};

/**
 * Add a menu item scoping a canonical product (and optional variant) into a
 * section. Validates that the section exists, the product is an in-scope,
 * non-archived canonical row, and the variant (when given) belongs to that product.
 */
export async function createMenuItem(db: ScopedDb, input: CreateMenuItemInput) {
  await assertSectionInScope(db, input.sectionId);
  await assertProductUsable(db, input.productId);
  const variantId = input.variantId ?? null;
  if (variantId) await assertVariantMatchesProduct(db, variantId, input.productId);

  return db.restaurantMenuItem.create({
    data: {
      sectionId: input.sectionId,
      productId: input.productId,
      variantId,
      displayName: input.displayName ?? null,
      nameLocalized: localizedWrite(input.nameLocalized),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export type UpdateMenuItemInput = {
  variantId?: string | null;
  displayName?: string | null;
  nameLocalized?: LocalizedInput;
  sortOrder?: number;
};

/**
 * Patch a menu item's presentation fields. Changing the variant re-validates it
 * against the item's existing product; the product itself is stable (swap the
 * product by deleting and re-adding the item).
 */
export async function updateMenuItem(db: ScopedDb, id: string, patch: UpdateMenuItemInput) {
  const existing = await db.restaurantMenuItem.findUnique({
    where: { id },
    select: { id: true, productId: true },
  });
  if (!existing) {
    throw new MenuError('The menu item does not exist.', 'NOT_FOUND');
  }

  const data: Prisma.RestaurantMenuItemUncheckedUpdateInput = {};
  if (patch.variantId !== undefined) {
    if (patch.variantId) await assertVariantMatchesProduct(db, patch.variantId, existing.productId);
    data.variantId = patch.variantId;
  }
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.nameLocalized !== undefined) data.nameLocalized = localizedWrite(patch.nameLocalized);
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;

  return db.restaurantMenuItem.update({ where: { id }, data });
}

export async function deleteMenuItem(db: ScopedDb, id: string) {
  const existing = await db.restaurantMenuItem.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new MenuError('The menu item does not exist.', 'NOT_FOUND');
  }
  await db.restaurantMenuItem.delete({ where: { id } });
  return { id };
}
