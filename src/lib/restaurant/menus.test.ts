import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  MenuError,
  createMenu,
  createMenuItem,
  createMenuSection,
  deleteMenu,
  updateMenuItem,
} from './menus';

const mocks = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  menuFindUnique: vi.fn(),
  menuCreate: vi.fn(),
  menuDelete: vi.fn(),
  sectionFindUnique: vi.fn(),
  sectionCreate: vi.fn(),
  itemFindUnique: vi.fn(),
  itemCreate: vi.fn(),
  itemUpdate: vi.fn(),
  productFindUnique: vi.fn(),
  variantFindUnique: vi.fn(),
  publicationFindFirst: vi.fn(),
}));

const db = {
  restaurantBrand: { findUnique: mocks.brandFindUnique },
  restaurantMenu: {
    findUnique: mocks.menuFindUnique,
    create: mocks.menuCreate,
    delete: mocks.menuDelete,
  },
  restaurantMenuSection: { findUnique: mocks.sectionFindUnique, create: mocks.sectionCreate },
  restaurantMenuItem: {
    findUnique: mocks.itemFindUnique,
    create: mocks.itemCreate,
    update: mocks.itemUpdate,
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
  mocks.sectionFindUnique.mockResolvedValue({ id: 'section_1' });
  mocks.sectionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'section_new',
    ...data,
  }));
  mocks.productFindUnique.mockResolvedValue({ id: 'prod_1', status: 'ACTIVE' });
  mocks.variantFindUnique.mockResolvedValue({ id: 'var_1', productId: 'prod_1' });
  mocks.itemFindUnique.mockResolvedValue({ id: 'item_1', productId: 'prod_1' });
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
  mocks.publicationFindFirst.mockResolvedValue(null);
});

describe('createMenu', () => {
  it('creates a brand-owned menu', async () => {
    const menu = await createMenu(db, { brandId: 'brand_1', name: 'Dinner' });
    expect(menu).toMatchObject({ id: 'menu_new', brandId: 'brand_1', name: 'Dinner' });
  });
  it('rejects a brand outside the organization', async () => {
    mocks.brandFindUnique.mockResolvedValue(null);
    await expect(createMenu(db, { brandId: 'other', name: 'Dinner' })).rejects.toMatchObject({
      reason: 'BRAND_NOT_FOUND',
    });
  });
  it('rejects a blank name', async () => {
    await expect(createMenu(db, { brandId: 'brand_1', name: '  ' })).rejects.toThrow(MenuError);
  });
});

describe('createMenuSection', () => {
  it('creates a section under an in-scope menu', async () => {
    const section = await createMenuSection(db, { menuId: 'menu_1', name: 'Starters', sortOrder: 2 });
    expect(section).toMatchObject({ menuId: 'menu_1', name: 'Starters', sortOrder: 2 });
  });
  it('rejects a menu outside the organization', async () => {
    mocks.menuFindUnique.mockResolvedValue(null);
    await expect(createMenuSection(db, { menuId: 'other', name: 'Starters' })).rejects.toMatchObject(
      { reason: 'MENU_NOT_FOUND' }
    );
  });
});

describe('createMenuItem — canonical reference validation (C2)', () => {
  const input = { sectionId: 'section_1', productId: 'prod_1' };

  it('creates an item referencing an in-scope product', async () => {
    const item = await createMenuItem(db, input);
    expect(item).toMatchObject({ sectionId: 'section_1', productId: 'prod_1', variantId: null });
  });
  it('rejects a product outside the organization', async () => {
    mocks.productFindUnique.mockResolvedValue(null);
    await expect(createMenuItem(db, input)).rejects.toMatchObject({ reason: 'PRODUCT_NOT_FOUND' });
  });
  it('rejects an archived product', async () => {
    mocks.productFindUnique.mockResolvedValue({ id: 'prod_1', status: 'ARCHIVED' });
    await expect(createMenuItem(db, input)).rejects.toMatchObject({ reason: 'PRODUCT_ARCHIVED' });
  });
  it('rejects a variant that belongs to another product', async () => {
    mocks.variantFindUnique.mockResolvedValue({ id: 'var_x', productId: 'other' });
    await expect(createMenuItem(db, { ...input, variantId: 'var_x' })).rejects.toMatchObject({
      reason: 'VARIANT_MISMATCH',
    });
  });
  it('accepts a variant that belongs to the referenced product', async () => {
    const item = await createMenuItem(db, { ...input, variantId: 'var_1' });
    expect(item).toMatchObject({ variantId: 'var_1' });
  });
});

describe('updateMenuItem', () => {
  it('re-validates a changed variant against the existing product', async () => {
    mocks.variantFindUnique.mockResolvedValue({ id: 'var_2', productId: 'other' });
    await expect(updateMenuItem(db, 'item_1', { variantId: 'var_2' })).rejects.toMatchObject({
      reason: 'VARIANT_MISMATCH',
    });
  });
  it('clears the variant when set to null without a lookup', async () => {
    const item = await updateMenuItem(db, 'item_1', { variantId: null });
    expect(item).toMatchObject({ variantId: null });
    expect(mocks.variantFindUnique).not.toHaveBeenCalled();
  });
  it('rejects an unknown item', async () => {
    mocks.itemFindUnique.mockResolvedValue(null);
    await expect(updateMenuItem(db, 'nope', { sortOrder: 1 })).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });
});

describe('deleteMenu — GOV-2 history guard', () => {
  it('deletes a menu with no published history', async () => {
    const result = await deleteMenu(db, 'menu_1');
    expect(result).toEqual({ id: 'menu_1' });
    expect(mocks.menuDelete).toHaveBeenCalledWith({ where: { id: 'menu_1' } });
  });
  it('refuses to delete a menu with published/retired publications', async () => {
    mocks.publicationFindFirst.mockResolvedValue({ id: 'pub_1' });
    await expect(deleteMenu(db, 'menu_1')).rejects.toMatchObject({ reason: 'MENU_IN_USE' });
    expect(mocks.menuDelete).not.toHaveBeenCalled();
  });
});
