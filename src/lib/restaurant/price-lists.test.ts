import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PriceListError,
  activatePriceListVersion,
  addPriceListEntry,
  createPriceList,
  createPriceListVersion,
  normalizePrice,
  pickEntry,
  resolvePrice,
  supersedePriceListVersion,
} from './price-lists';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  listCreate: vi.fn(),
  listUpdateMany: vi.fn(),
  listFindUnique: vi.fn(),
  versionCreate: vi.fn(),
  versionUpdate: vi.fn(),
  versionFindUnique: vi.fn(),
  versionFindMany: vi.fn(),
  entryCreate: vi.fn(),
  entryFindFirst: vi.fn(),
  entryFindUnique: vi.fn(),
  entryFindMany: vi.fn(),
  productFindUnique: vi.fn(),
  variantFindUnique: vi.fn(),
}));

const db = {
  restaurantPriceList: {
    create: mocks.listCreate,
    updateMany: mocks.listUpdateMany,
    findUnique: mocks.listFindUnique,
  },
  restaurantPriceListVersion: {
    create: mocks.versionCreate,
    update: mocks.versionUpdate,
    findUnique: mocks.versionFindUnique,
    findMany: mocks.versionFindMany,
  },
  restaurantPriceListEntry: {
    create: mocks.entryCreate,
    findFirst: mocks.entryFindFirst,
    findUnique: mocks.entryFindUnique,
    findMany: mocks.entryFindMany,
  },
  restaurantProduct: { findUnique: mocks.productFindUnique },
  restaurantProductVariant: { findUnique: mocks.variantFindUnique },
  // createPriceList's default path runs in a transaction; reuse the same delegates.
  $transaction: (cb: (tx: unknown) => unknown) => cb(db),
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'pl_1',
    ...data,
  }));
  mocks.listUpdateMany.mockResolvedValue({ count: 0 });
  mocks.listFindUnique.mockResolvedValue({ id: 'pl_1' });
  mocks.versionFindMany.mockResolvedValue([]);
  mocks.versionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'plv_new',
    ...data,
  }));
  mocks.versionUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
  mocks.versionFindUnique.mockResolvedValue({ id: 'plv_1', status: 'DRAFT' });
  mocks.productFindUnique.mockResolvedValue({ id: 'prod_1' });
  mocks.variantFindUnique.mockResolvedValue({ id: 'var_1', productId: 'prod_1' });
  mocks.entryFindFirst.mockResolvedValue(null);
  mocks.entryCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'ple_new',
    ...data,
  }));
});

describe('normalizePrice (C4)', () => {
  it('accepts a well-formed money string', () => {
    expect(normalizePrice('12.50').toFixed(2)).toBe('12.50');
  });
  it('rejects a negative price', () => {
    expect(() => normalizePrice('-1')).toThrow(PriceListError);
  });
  it('rejects more than two decimal places', () => {
    expect(() => normalizePrice('1.234')).toThrow(/two decimal places/);
  });
  it('rejects a non-decimal input', () => {
    expect(() => normalizePrice('abc')).toThrow(PriceListError);
  });
  it('rejects an over-large amount', () => {
    expect(() => normalizePrice('10000000000')).toThrow(/maximum/);
  });
});

describe('pickEntry — variant fallback', () => {
  const entries = [
    { id: 'e_base', productId: 'p1', variantId: null, price: D('10.00') },
    { id: 'e_var', productId: 'p1', variantId: 'v1', price: D('12.00') },
  ];
  it('prefers the exact (product, variant) entry', () => {
    expect(pickEntry(entries, 'p1', 'v1')?.id).toBe('e_var');
  });
  it('falls back to the base entry when the variant is unpriced', () => {
    expect(pickEntry(entries, 'p1', 'v2')?.id).toBe('e_base');
  });
  it('uses the base entry for a base (null-variant) request', () => {
    expect(pickEntry(entries, 'p1', null)?.id).toBe('e_base');
  });
  it('returns null when the product is not priced', () => {
    expect(pickEntry(entries, 'p2', null)).toBeNull();
  });
});

describe('createPriceList', () => {
  it('creates a non-default list without touching others', async () => {
    await createPriceList(db, { name: 'Lunch' });
    expect(mocks.listUpdateMany).not.toHaveBeenCalled();
    expect(mocks.listCreate).toHaveBeenCalledWith({ data: { name: 'Lunch', isDefault: false } });
  });
  it('demotes prior defaults when creating the base list', async () => {
    await createPriceList(db, { name: 'Base', isDefault: true });
    expect(mocks.listUpdateMany).toHaveBeenCalledWith({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    expect(mocks.listCreate).toHaveBeenCalledWith({ data: { name: 'Base', isDefault: true } });
  });
  it('rejects a blank name', async () => {
    await expect(createPriceList(db, { name: '   ' })).rejects.toThrow(PriceListError);
  });
});

describe('createPriceListVersion', () => {
  it('assigns the next monotonic version number', async () => {
    mocks.versionFindMany.mockResolvedValue([
      { versionNumber: 1, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
      { versionNumber: 2, effectiveFrom: new Date('2026-02-01T00:00:00Z') },
    ]);
    await createPriceListVersion(db, {
      priceListId: 'pl_1',
      effectiveFrom: new Date('2026-03-01T00:00:00Z'),
    });
    expect(mocks.versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ versionNumber: 3 }) })
    );
  });
  it('rejects a duplicate effective date', async () => {
    mocks.versionFindMany.mockResolvedValue([
      { versionNumber: 1, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    ]);
    await expect(
      createPriceListVersion(db, {
        priceListId: 'pl_1',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      })
    ).rejects.toMatchObject({ reason: 'DUPLICATE_EFFECTIVE_FROM' });
  });
  it('rejects an unknown price list', async () => {
    mocks.listFindUnique.mockResolvedValue(null);
    await expect(
      createPriceListVersion(db, { priceListId: 'nope', effectiveFrom: new Date() })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});

describe('addPriceListEntry — canonical validation & immutability', () => {
  const input = { priceListVersionId: 'plv_1', productId: 'prod_1', price: '9.99' };

  it('writes a Decimal price to a DRAFT version', async () => {
    await addPriceListEntry(db, input);
    const created = mocks.entryCreate.mock.calls[0][0].data;
    expect(created.price).toBeInstanceOf(Prisma.Decimal);
    expect(created.price.toFixed(2)).toBe('9.99');
    expect(created.variantId).toBeNull();
  });
  it('refuses to edit a non-DRAFT (immutable) version (C3)', async () => {
    mocks.versionFindUnique.mockResolvedValue({ id: 'plv_1', status: 'ACTIVE' });
    await expect(addPriceListEntry(db, input)).rejects.toMatchObject({
      name: 'VersionImmutabilityError',
    });
    expect(mocks.entryCreate).not.toHaveBeenCalled();
  });
  it('rejects a product outside the organization', async () => {
    mocks.productFindUnique.mockResolvedValue(null);
    await expect(addPriceListEntry(db, input)).rejects.toMatchObject({
      reason: 'PRODUCT_NOT_FOUND',
    });
  });
  it('rejects a variant that belongs to another product', async () => {
    mocks.variantFindUnique.mockResolvedValue({ id: 'var_x', productId: 'other' });
    await expect(addPriceListEntry(db, { ...input, variantId: 'var_x' })).rejects.toMatchObject({
      reason: 'VARIANT_MISMATCH',
    });
  });
  it('rejects a duplicate (version, product, variant) entry', async () => {
    mocks.entryFindFirst.mockResolvedValue({ id: 'ple_existing' });
    await expect(addPriceListEntry(db, input)).rejects.toMatchObject({ reason: 'ENTRY_EXISTS' });
  });
});

describe('version lifecycle transitions (L1 primitives)', () => {
  it('activates a DRAFT version at the server instant', async () => {
    const at = new Date('2026-05-01T00:00:00Z');
    await activatePriceListVersion(db, 'plv_1', at);
    expect(mocks.versionUpdate).toHaveBeenCalledWith({
      where: { id: 'plv_1' },
      data: { status: 'ACTIVE', activatedAt: at },
    });
  });
  it('refuses to activate a non-DRAFT version', async () => {
    mocks.versionFindUnique.mockResolvedValue({ id: 'plv_1', status: 'ACTIVE' });
    await expect(activatePriceListVersion(db, 'plv_1', new Date())).rejects.toMatchObject({
      name: 'VersionTransitionError',
    });
  });
  it('supersedes an ACTIVE version', async () => {
    mocks.versionFindUnique.mockResolvedValue({ id: 'plv_1', status: 'ACTIVE' });
    const at = new Date('2026-06-01T00:00:00Z');
    await supersedePriceListVersion(db, 'plv_1', at);
    expect(mocks.versionUpdate).toHaveBeenCalledWith({
      where: { id: 'plv_1' },
      data: { status: 'SUPERSEDED', supersededAt: at },
    });
  });
});

describe('resolvePrice — effective-dated resolution & boundary instant', () => {
  beforeEach(() => {
    mocks.versionFindMany.mockResolvedValue([
      {
        id: 'v1',
        versionNumber: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        status: 'ACTIVE',
      },
      {
        id: 'v2',
        versionNumber: 2,
        effectiveFrom: new Date('2026-02-01T00:00:00Z'),
        status: 'ACTIVE',
      },
    ]);
    mocks.entryFindMany.mockImplementation(
      async ({ where }: { where: { priceListVersionId: string } }) => {
        const price = where.priceListVersionId === 'v2' ? '12.00' : '10.00';
        return [
          {
            id: `e_${where.priceListVersionId}`,
            productId: 'p1',
            variantId: null,
            price: D(price),
          },
        ];
      }
    );
  });

  it('applies the new version exactly at its effectiveFrom instant (inclusive boundary)', async () => {
    const result = await resolvePrice(db, {
      priceListId: 'pl_1',
      productId: 'p1',
      at: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(result?.version.id).toBe('v2');
    expect(result?.price.toFixed(2)).toBe('12.00');
  });

  it('applies the prior version one millisecond before the boundary', async () => {
    const result = await resolvePrice(db, {
      priceListId: 'pl_1',
      productId: 'p1',
      at: new Date('2026-01-31T23:59:59.999Z'),
    });
    expect(result?.version.id).toBe('v1');
    expect(result?.price.toFixed(2)).toBe('10.00');
  });

  it('returns null before any version is in force', async () => {
    const result = await resolvePrice(db, {
      priceListId: 'pl_1',
      productId: 'p1',
      at: new Date('2025-12-31T23:59:59Z'),
    });
    expect(result).toBeNull();
  });
});
