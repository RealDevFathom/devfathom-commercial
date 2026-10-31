import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  MenuError,
  createMenu,
  createMenuItem,
  createMenuSection,
  deleteMenu,
  deleteMenuItem,
  updateMenu,
  updateMenuItem,
} from './menus';

const mocks = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  menuFindUnique: vi.fn(),
  menuCreate: vi.fn(),
  menuUpdate: vi.fn(),
  menuDelete: vi.fn(),
  sectionFindUnique: vi.fn(),
  sectionCreate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  itemDelete: vi.fn(),
  productFindUnique: vi.fn(),
  variantFindUnique: vi.fn(),
  publicationFindFirst: vi.fn(),
}));

const db = {
  restaurantBrand: { findUnique: mocks.brandFindUnique },
  restaurantMenu: {
    findUnique: mocks.menuFindUnique,
    create: mocks.menuCreate,
    update: mocks.menuUpdate,
    delete: mocks.menuDelete,
  },
  restaurantMenuSection: {
    findUnique: mocks.sectionFindUnique,
    create: mocks.sectionCreate,
  },
  restaurantMenuItem: {
    findUnique: mocks.itemFindUnique,
    create: mocks.itemCreate,
    update: mocks.itemUpdate,
    delete: mocks.itemDelete,
  },
  restaurantProduct: { findUnique: mocks.productFindUnique },
  restaurantProductVariant: { findUnique: mocks.variantFindUnique },
  restaurantBranchMenuPublication: { findFirst: mocks.publicationFindFirst },
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.brandFindUnique.mockResolvedValue({ id: 'brand_1' });
  mocks.menuFindUnique.mockResolvedValue({ id: 'menu_1' });
  mocks.menuCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'menu_new',
    ...data,
  }));
  mocks.menuUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
  mocks.sectionFindUnique.mockResolvedValue({ id: 'section_1' });
  mocks.sectionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'section_new',
    ...data,
  }));
  mocks.itemFindUnique.mockResolvedValue({ id: 'item_1' });
  mocks.itemCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'item_new',
    ...data,
  }));
  mocks.itemUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
  mocks.productFindUnique.mockResolvedValue({ id: 'prod_1' });
  mocks.variantFindUnique.mockResolvedValue({ id: 'var_1', productId: 'prod_1' });
  mocks.publicationFindFirst.mockResolvedValue(null);
});

describe('createMenu', () => {
  it('creates a brand-owned menu after validating the brand is in scope', async () => {
    const menu = await createMenu(db, { brandId: 'brand_1', name: 'Dinner' });
    expect(menu).toMatchObject({ id: 'menu_new', brandId: 'brand_1', name: 'Dinner' });
  });
  it('rejects a menu on a brand outside the organization (C2/RLS)', async () => {
    mocks.brandFindUnique.mockResolvedValue(null);
    await expect(createMenu(db, { brandId: 'other_org', name: 'X' })).rejects.toMatchObject({
      reason: 'BRAND_NOT_FOUND',
    });
    expect(mocks.menuCreate).not.toHaveBeenCalled();
  });
  it('rejects a blank name', async () => {
    await expect(createMenu(db, { brandId: 'brand_1', name: '  ' })).rejects.toThrow(MenuError);
  });
});

describe('updateMenu', () => {
  it('maps a missing menu to MENU_NOT_FOUND', async () => {
    mocks.menuFindUnique.mockResolvedValue(null);
    await expect(updateMenu(db, 'gone', { name: 'X' })).rejects.toMatchObject({
      reason: 'MENU_NOT_FOUND',
    });
  });
  it('clears localized names with a DB null when explicitly nulled', async () => {
    await updateMenu(db, 'menu_1', { nameLocalized: null });
    expect(mocks.menuUpdate.mock.calls[0][0].data.nameLocalized).toBe(Prisma.DbNull);
  });
});

describe('deleteMenu — live-publication guard', () => {
  it('refuses to delete a menu with a non-RETIRED publication', async () => {
    mocks.publicationFindFirst.mockResolvedValue({ id: 'pub_live' });
    await expect(deleteMenu(db, 'menu_1')).rejects.toMatchObject({ reason: 'MENU_IN_USE' });
    expect(mocks.menuDelete).not.toHaveBeenCalled();
  });
  it('deletes a menu with no live publication', async () => {
    const result = await deleteMenu(db, 'menu_1');
    expect(result).toEqual({ id: 'menu_1' });
    expect(mocks.menuDelete).toHaveBeenCalledWith({ where: { id: 'menu_1' } });
    // The guard scopes to non-RETIRED publications only.
    expect(mocks.publicationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { menuId: 'menu_1', status: { not: 'RETIRED' } } })
    );
  });
});

describe('createMenuSection', () => {
  it('rejects a section on a menu outside the organization', async () => {
    mocks.menuFindUnique.mockResolvedValue(null);
    await expect(
      createMenuSection(db, { menuId: 'other', name: 'Starters' })
    ).rejects.toMatchObject({ reason: 'MENU_NOT_FOUND' });
  });
  it('creates a section with a default sort order', async () => {
    const section = await createMenuSection(db, { menuId: 'menu_1', name: 'Starters' });
    expect(section).toMatchObject({ menuId: 'menu_1', name: 'Starters', sortOrder: 0 });
  });
});

describe('createMenuItem — canonical same-org reference validation (C2)', () => {
  const input = { sectionId: 'section_1', productId: 'prod_1' };

  it('adds an item referencing an in-scope product', async () => {
    const item = await createMenuItem(db, input);
    expect(item).toMatchObject({ sectionId: 'section_1', productId: 'prod_1', variantId: null });
  });
  it('rejects an item in a section outside the organization', async () => {
    mocks.sectionFindUnique.mockResolvedValue(null);
    await expect(createMenuItem(db, input)).rejects.toMatchObject({ reason: 'SECTION_NOT_FOUND' });
  });
  it('rejects a product outside the organization', async () => {
    mocks.productFindUnique.mockResolvedValue(null);
    await expect(createMenuItem(db, input)).rejects.toMatchObject({ reason: 'PRODUCT_NOT_FOUND' });
    expect(mocks.itemCreate).not.toHaveBeenCalled();
  });
  it('rejects a COMBO product until ordering supports combo selections', async () => {
    mocks.productFindUnique.mockResolvedValue({ id: 'prod_1', type: 'COMBO' });
    await expect(createMenuItem(db, input)).rejects.toMatchObject({
      reason: 'COMBO_NOT_ORDERABLE',
    });
    expect(mocks.itemCreate).not.toHaveBeenCalled();
  });
  it('rejects a variant belonging to another product', async () => {
    mocks.variantFindUnique.mockResolvedValue({ id: 'var_x', productId: 'other_prod' });
    await expect(createMenuItem(db, { ...input, variantId: 'var_x' })).rejects.toMatchObject({
      reason: 'VARIANT_MISMATCH',
    });
  });
  it('rejects a variant that does not exist in scope', async () => {
    mocks.variantFindUnique.mockResolvedValue(null);
    await expect(createMenuItem(db, { ...input, variantId: 'gone' })).rejects.toMatchObject({
      reason: 'VARIANT_NOT_FOUND',
    });
  });
});

describe('menu item presentation update / delete', () => {
  it('updates only presentation fields', async () => {
    await updateMenuItem(db, 'item_1', { displayName: 'Chef special', sortOrder: 3 });
    const data = mocks.itemUpdate.mock.calls[0][0].data;
    expect(data).toEqual({ displayName: 'Chef special', sortOrder: 3 });
    expect(data).not.toHaveProperty('productId');
  });
  it('maps a missing item to ITEM_NOT_FOUND on delete', async () => {
    mocks.itemFindUnique.mockResolvedValue(null);
    await expect(deleteMenuItem(db, 'gone')).rejects.toMatchObject({ reason: 'ITEM_NOT_FOUND' });
  });
});
