import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-174 — a foreign extracted price must never be committed unchanged as a
 * local (organization-currency) price. QA's two-step relabel: first change the
 * currency to PKR with no amount, then resubmit the extracted figure as PKR.
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

/** One import line whose review writes persist, so review and commit share state. */
function statefulDb(lineOverrides: Record<string, unknown> = {}) {
  const line: Record<string, unknown> = {
    id: 'line_1',
    importId: 'imp_1',
    reviewStatus: 'PENDING',
    sortOrder: 1,
    extractedCategoryName: 'Mains',
    extractedProductName: 'Club Sandwich',
    extractedDescription: null,
    extractedPriceAmount: new Prisma.Decimal('12.5'),
    extractedCurrency: 'USD',
    extractedVariants: [],
    reviewedVariants: null,
    reviewedCategoryName: null,
    reviewedProductName: null,
    reviewedDescription: null,
    reviewedPriceAmount: null,
    reviewedCurrency: null,
    mergeProductId: null,
    mergeVariantId: null,
    import: { status: 'AWAITING_REVIEW' },
    ...lineOverrides,
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
      findUnique: vi.fn(async () => line),
      findMany: vi.fn(async () => [line]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(line, data);
        return line;
      }),
    },
    restaurantCategory: { findMany: vi.fn(async () => []) },
    restaurantPriceList: { findFirst: vi.fn(async () => ({ id: 'pl_1' })), create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db: db as unknown as ScopedDb, line };
}

const commit = (db: ScopedDb) =>
  commitMenuImport(db, { importId: 'imp_1', committedById: 'user_1' });

describe('two-step currency relabel of a foreign extracted price', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDefaultBrand.mockResolvedValue({ id: 'brand_1' });
    mocks.createCategory.mockResolvedValue({ id: 'cat_1' });
    mocks.createMenu.mockResolvedValue({ id: 'menu_1' });
    mocks.createPriceListVersion.mockResolvedValue({ id: 'ver_1' });
    mocks.createMenuSection.mockResolvedValue({ id: 'sec_1' });
    mocks.createProduct.mockResolvedValue({ id: 'prod_1' });
    mocks.addPriceListEntry.mockResolvedValue({ id: 'entry_1' });
    mocks.createMenuItem.mockResolvedValue({ id: 'item_1' });
  });

  it('does not store the extracted figure as a reviewed PKR amount and refuses commit', async () => {
    const { db, line } = statefulDb();

    // Step 1: change the currency only.
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      currency: 'PKR',
    });
    expect(line.reviewedCurrency).toBe('PKR');
    expect(line.reviewedPriceAmount).toBeNull();

    // Step 2: resubmit the printed USD figure, now that the line already says PKR.
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: '12.50',
      currency: 'PKR',
    });
    expect(line.reviewedPriceAmount).toBeNull();

    await expect(commit(db)).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
    expect(mocks.addPriceListEntry).not.toHaveBeenCalled();
  });

  it('refuses the relabel when step 2 omits the currency', async () => {
    const { db, line } = statefulDb();
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      currency: 'PKR',
    });
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: '12.5',
    });
    expect(line.reviewedPriceAmount).toBeNull();
    await expect(commit(db)).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
  });

  it('refuses at commit a stored PKR amount equal to the extracted foreign figure', async () => {
    // A row written around the review path still cannot carry the relabel through.
    const { db } = statefulDb({
      reviewStatus: 'ACCEPTED',
      reviewedPriceAmount: new Prisma.Decimal('12.50'),
      reviewedCurrency: 'PKR',
    });
    await expect(commit(db)).rejects.toMatchObject({ reason: 'CURRENCY_MISMATCH' });
    expect(mocks.addPriceListEntry).not.toHaveBeenCalled();
  });

  it('commits a genuinely converted PKR amount', async () => {
    const { db, line } = statefulDb();
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      currency: 'PKR',
    });
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: '3500',
      currency: 'PKR',
    });
    expect(String(line.reviewedPriceAmount)).toBe('3500');
    await commit(db);
    expect(mocks.addPriceListEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ price: new Prisma.Decimal('3500') })
    );
  });

  it('still accepts a printed PKR figure confirmed unchanged', async () => {
    const { db, line } = statefulDb({
      extractedCurrency: 'PKR',
      extractedPriceAmount: new Prisma.Decimal('1200'),
    });
    await reviewMenuImportLine(db, {
      lineId: 'line_1',
      decision: 'ACCEPTED',
      reviewedById: 'user_1',
      priceAmount: '1200',
      currency: 'PKR',
    });
    expect(String(line.reviewedPriceAmount)).toBe('1200');
    await commit(db);
    expect(mocks.addPriceListEntry).toHaveBeenCalledOnce();
  });
});
