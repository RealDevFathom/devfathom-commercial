import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-175 — accepting a line must not import size (variant) prices the reviewer
 * never saw. The review call demands an explicit size confirmation when the
 * extraction found sizes, and commit imports only the confirmed sizes.
 */

const mocks = vi.hoisted(() => ({
  createProduct: vi.fn(),
  createCategory: vi.fn(),
  createVariant: vi.fn(),
  ensureDefaultBrand: vi.fn(),
  createMenu: vi.fn(),
  createMenuItem: vi.fn(),
  createMenuSection: vi.fn(),
  addPriceListEntry: vi.fn(),
  createPriceListVersion: vi.fn(),
}));

vi.mock('@/lib/restaurant/scheduler', () => ({ enqueue: vi.fn() }));
vi.mock('@/lib/restaurant/catalog', () => ({
  createProduct: mocks.createProduct,
  createCategory: mocks.createCategory,
  createVariant: mocks.createVariant,
  ensureDefaultBrand: mocks.ensureDefaultBrand,
}));
vi.mock('@/lib/restaurant/menus', () => ({
  createMenu: mocks.createMenu,
  createMenuItem: mocks.createMenuItem,
  createMenuSection: mocks.createMenuSection,
}));
vi.mock('@/lib/restaurant/price-lists', () => ({
  addPriceListEntry: mocks.addPriceListEntry,
  createPriceListVersion: mocks.createPriceListVersion,
}));

import { Prisma } from '@/generated/prisma/client';
import { commitMenuImport, reviewMenuImportLine } from './menu-import';

const EXTRACTED_SIZES = [
  { name: 'Small 9"', price: { amount: '1200.00', currency: null, raw: 'Rs. 1,200' } },
  { name: 'Medium 12"', price: { amount: '1850.00', currency: null, raw: 'Rs. 1,850' } },
  { name: 'Large 15"', price: { amount: '2600.00', currency: null, raw: 'Rs. 2,600' } },
];

function reviewDb(lineOverrides: Record<string, unknown> = {}) {
  const line = {
    id: 'line_1',
    importId: 'imp_1',
    extractedProductName: 'Chicken Fajita Pizza',
    extractedPriceAmount: new Prisma.Decimal('1200'),
    extractedCurrency: 'PKR',
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    extractedVariants: EXTRACTED_SIZES,
    reviewedVariants: null,
    import: { status: 'AWAITING_REVIEW' },
    ...lineOverrides,
  };
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...line,
    ...data,
  }));
  const db = {
    restaurantMenuImportLine: { findUnique: vi.fn(async () => line), update },
  };
  return { db: db as unknown as ScopedDb, update };
}

describe('reviewing a line with extracted sizes', () => {
  it('refuses to accept the base line without a confirmation of its sizes', async () => {
    const { db, update } = reviewDb();
    await expect(
      reviewMenuImportLine(db, { lineId: 'line_1', decision: 'ACCEPTED', reviewedById: 'user_1' })
    ).rejects.toMatchObject({ reason: 'VARIANTS_REVIEW_REQUIRED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('stores the sizes exactly as the reviewer confirmed them', async () => {
    const { db, update } = reviewDb();
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      variants: [
        { name: ' Small 9" ', priceAmount: '1250' },
        { name: 'Large 15"', priceAmount: null },
      ],
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewStatus: 'ACCEPTED',
          reviewedVariants: [
            { name: 'Small 9"', price: { amount: '1250.00', currency: null, raw: null } },
            { name: 'Large 15"', price: { amount: null, currency: null, raw: null } },
          ],
        }),
      })
    );
  });

  it('keeps the printed currency when the printed size figure is re-confirmed', async () => {
    const { db, update } = reviewDb({
      extractedVariants: [
        { name: 'Large', price: { amount: '15.00', currency: 'usd', raw: '$15' } },
        { name: 'Small', price: { amount: '10.00', currency: 'USD', raw: '$10' } },
      ],
    });
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      variants: [
        { name: 'large', priceAmount: '15' },
        { name: 'Small', priceAmount: '2800' },
      ],
    });
    expect(update.mock.calls[0]![0].data.reviewedVariants).toEqual([
      { name: 'large', price: { amount: '15.00', currency: 'USD', raw: null } },
      { name: 'Small', price: { amount: '2800.00', currency: null, raw: null } },
    ]);
  });

  it('keeps the printed currency when only the size name is corrected', async () => {
    const { db, update } = reviewDb({
      extractedVariants: [
        { name: 'Lagre', price: { amount: '15.00', currency: 'USD', raw: '$15' } },
      ],
    });
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      variants: [{ name: 'Large', priceAmount: '15.00' }],
    });
    expect(update.mock.calls[0]![0].data.reviewedVariants).toEqual([
      { name: 'Large', price: { amount: '15.00', currency: 'USD', raw: null } },
    ]);
  });

  it('accepts an explicit confirmation that the line has no sizes', async () => {
    const { db, update } = reviewDb();
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      variants: [],
    });
    expect(update.mock.calls[0]![0].data.reviewedVariants).toEqual([]);
  });

  it('keeps an earlier size confirmation when re-accepting without one', async () => {
    const { db, update } = reviewDb({ reviewedVariants: [] });
    await reviewMenuImportLine(db, { lineId: 'line_1', decision: 'ACCEPTED', reviewedById: 'u' });
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('reviewedVariants');
  });

  it('does not demand a size confirmation when nothing was extracted', async () => {
    const { db, update } = reviewDb({ extractedVariants: [] });
    await reviewMenuImportLine(db, { lineId: 'line_1', decision: 'ACCEPTED', reviewedById: 'u' });
    expect(update).toHaveBeenCalledOnce();
  });

  it.each([
    [{ name: 'Small', priceAmount: '-5' }],
    [{ name: 'Small', priceAmount: 'abc' }],
    [{ name: '   ', priceAmount: '100' }],
  ])('rejects an invalid confirmed size %j', async (variant) => {
    const { db, update } = reviewDb();
    await expect(
      reviewMenuImportLine(db, {
        lineId: 'line_1',
        decision: 'ACCEPTED',
        reviewedById: 'u',
        variants: [variant],
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects the same size confirmed twice', async () => {
    const { db } = reviewDb();
    await expect(
      reviewMenuImportLine(db, {
        lineId: 'line_1',
        decision: 'ACCEPTED',
        reviewedById: 'u',
        variants: [
          { name: 'Small', priceAmount: '100' },
          { name: 'small', priceAmount: '120' },
        ],
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });
});

function commitDb(reviewedVariants: unknown) {
  const line = {
    id: 'line_1',
    reviewStatus: 'ACCEPTED',
    sortOrder: 1,
    extractedCategoryName: 'Pizza',
    extractedProductName: 'Chicken Fajita Pizza',
    extractedDescription: null,
    extractedPriceAmount: new Prisma.Decimal('1200'),
    extractedCurrency: 'PKR',
    extractedVariants: EXTRACTED_SIZES,
    reviewedVariants,
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
  };
  const db = {
    $queryRaw: vi.fn(async () => [{ currency: 'PKR' }]),
    restaurantMenuImport: {
      findUnique: vi.fn(async () => ({
        id: 'imp_1',
        organizationId: 'org_1',
        status: 'AWAITING_REVIEW',
        fileName: 'menu.png',
        storageObjectName: null,
        committedMenuId: null,
        committedPriceListVersionId: null,
      })),
      update: vi.fn(async () => ({})),
    },
    restaurantMenuImportLine: {
      findMany: vi.fn(async () => [line]),
      update: vi.fn(async () => ({})),
    },
    restaurantCategory: { findMany: vi.fn(async () => []) },
    restaurantPriceList: { findFirst: vi.fn(async () => ({ id: 'pl_1' })), create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as unknown as ScopedDb;
}

describe('committing sizes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDefaultBrand.mockResolvedValue({ id: 'brand_1' });
    mocks.createCategory.mockResolvedValue({ id: 'cat_1' });
    mocks.createMenu.mockResolvedValue({ id: 'menu_1' });
    mocks.createPriceListVersion.mockResolvedValue({ id: 'ver_1' });
    mocks.createMenuSection.mockResolvedValue({ id: 'sec_1' });
    mocks.createProduct.mockResolvedValue({ id: 'prod_1' });
    mocks.createVariant.mockImplementation(async (_tx, { name }: { name: string }) => ({
      id: `var_${name}`,
    }));
    let entry = 0;
    mocks.addPriceListEntry.mockImplementation(async () => ({ id: `entry_${(entry += 1)}` }));
    mocks.createMenuItem.mockResolvedValue({ id: 'item_1' });
  });

  it('refuses an accepted line whose extracted sizes were never confirmed', async () => {
    await expect(
      commitMenuImport(commitDb(null), { importId: 'imp_1', committedById: 'user_1' })
    ).rejects.toMatchObject({ reason: 'REVIEW_INCOMPLETE' });
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.createVariant).not.toHaveBeenCalled();
    expect(mocks.addPriceListEntry).not.toHaveBeenCalled();
  });

  it('imports only the confirmed sizes and prices, never the OCR ones', async () => {
    const result = await commitMenuImport(
      commitDb([{ name: 'Small 9"', price: { amount: '1250.00', currency: null, raw: null } }]),
      { importId: 'imp_1', committedById: 'user_1' }
    );

    expect(mocks.createVariant).toHaveBeenCalledOnce();
    expect(mocks.createVariant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Small 9"' })
    );
    const prices = mocks.addPriceListEntry.mock.calls.map(([, entry]) => [
      entry.variantId,
      String(entry.price),
    ]);
    expect(prices).toEqual([
      ['var_Small 9"', '1250.00'],
      [null, '1200'],
    ]);
    expect(result.priceEntryIds).toHaveLength(2);
  });

  it('refuses a confirmed size that is still in a foreign printed currency', async () => {
    await expect(
      commitMenuImport(
        commitDb([{ name: 'Large', price: { amount: '15.00', currency: 'USD', raw: null } }]),
        { importId: 'imp_1', committedById: 'user_1' }
      )
    ).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
    expect(mocks.createProduct).not.toHaveBeenCalled();
  });

  it('imports no sizes when the reviewer confirmed none', async () => {
    await commitMenuImport(commitDb([]), { importId: 'imp_1', committedById: 'user_1' });
    expect(mocks.createVariant).not.toHaveBeenCalled();
    expect(mocks.addPriceListEntry).toHaveBeenCalledOnce();
  });
});
