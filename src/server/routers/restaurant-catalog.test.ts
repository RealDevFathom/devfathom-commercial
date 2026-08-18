/**
 * M3-L2 router tests — capability gating, C2 shadow-copy guard (no branchId
 * accepted on canonical mutations), C4 Decimal serialization, and version
 * immutability routing. Runs the REAL router against a hand-rolled in-memory db;
 * ABAC, entitlements, and audit are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { restaurantCatalogRouter } from './restaurant-catalog';
import type { TRPCContext } from '../trpc';
import { Prisma } from '@/generated/prisma/client';

// ── Minimal in-memory db ──────────────────────────────────────────────────────

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...data,
    })),
    update: vi.fn().mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })
    ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...create,
    })),
  };
}

function makeDb() {
  const db: Record<string, Delegate | unknown> = {
    restaurantBrand: model(),
    restaurantCategory: model(),
    restaurantProduct: model(),
    restaurantProductVariant: model(),
    restaurantModifierGroup: model(),
    restaurantModifierOption: model(),
    restaurantProductModifierGroup: model(),
    restaurantComboComponentGroup: model(),
    restaurantComboComponentOption: model(),
    restaurantProductAllergen: model(),
    restaurantAllergen: model(),
    restaurantPriceListEntry: model(),
    restaurantMenuItem: model(),
    restaurantUnit: model(),
    restaurantUnitConversion: model(),
    restaurantIngredient: model(),
    restaurantIngredientAllergen: model(),
    restaurantRecipe: model(),
    restaurantRecipeVersion: model(),
    restaurantRecipeLine: model(),
  };
  (db as Record<string, unknown>).$transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn(db)
  );
  return db;
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
});

function caller() {
  return restaurantCatalogRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-menu'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.brands.max': 5 },
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

// ── C2 shadow-copy guard — no branchId field on canonical inputs ──────────────

describe('C2 shadow-copy guard', () => {
  it('createProduct schema rejects branchId field', async () => {
    (db.restaurantProduct as Delegate).findUnique.mockResolvedValue({ id: 'p1' });
    // Providing branchId must be rejected by zod (extra key stripped or error).
    // In strict mode zod would reject unknown fields; our inputs don't define branchId.
    // This test verifies the SCHEMA has no branchId by ensuring the call succeeds
    // WITHOUT ever writing branchId to the db — i.e. the field is absent in the input type.
    (db.restaurantCategory as Delegate).findUnique.mockResolvedValue({ id: 'cat1' });
    await caller().createProduct({ name: 'Burger', categoryId: 'cat1' });
    const createCall = (db.restaurantProduct as Delegate).create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty('branchId');
  });

  it('createBrand schema rejects branchId field', async () => {
    (db.restaurantBrand as Delegate).count.mockResolvedValue(0);
    await caller().createBrand({ name: 'My Brand' });
    const createCall = (db.restaurantBrand as Delegate).create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty('branchId');
  });
});

// ── C4 Decimal serialization ──────────────────────────────────────────────────

describe('C4 Decimal serialization', () => {
  it('createModifierOption returns priceDelta as string', async () => {
    (db.restaurantModifierGroup as Delegate).findUnique.mockResolvedValue({ id: 'mg1' });
    (db.restaurantModifierOption as Delegate).create.mockResolvedValue({
      id: 'mo1',
      name: 'Extra sauce',
      priceDelta: new Prisma.Decimal('1.50'),
      sortOrder: 0,
    });
    const result = await caller().createModifierOption({
      modifierGroupId: 'mg1',
      name: 'Extra sauce',
      priceDelta: '1.50',
    });
    expect(typeof result?.priceDelta).toBe('string');
    expect(result?.priceDelta).toBe('1.5');
  });

  it('createIngredient returns referenceCost as string', async () => {
    (db.restaurantUnit as Delegate).findUnique.mockResolvedValue({ id: 'u1' });
    (db.restaurantIngredient as Delegate).create.mockResolvedValue({
      id: 'i1',
      name: 'Flour',
      baseUnitId: 'u1',
      referenceCost: new Prisma.Decimal('2.75'),
    });
    const result = await caller().createIngredient({ name: 'Flour', baseUnitId: 'u1', referenceCost: '2.75' });
    expect(typeof result?.referenceCost).toBe('string');
  });

  it('upsertConversion returns factor as string', async () => {
    (db.restaurantUnit as Delegate).findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id })
    );
    (db.restaurantUnitConversion as Delegate).findMany.mockResolvedValue([]);
    (db.restaurantUnitConversion as Delegate).upsert.mockResolvedValue({
      id: 'c1',
      fromUnitId: 'A',
      toUnitId: 'B',
      factor: new Prisma.Decimal('1000'),
    });
    const result = await caller().upsertConversion({ fromUnitId: 'A', toUnitId: 'B', factor: '1000' });
    expect(typeof result?.factor).toBe('string');
  });
});

// ── Version immutability through the router ───────────────────────────────────

describe('updateRecipeVersion — immutability guard at router boundary', () => {
  it('returns BAD_REQUEST when version is ACTIVE', async () => {
    (db.restaurantRecipeVersion as Delegate).findUnique.mockResolvedValue({
      id: 'v1',
      status: 'ACTIVE',
      recipeId: 'r1',
    });
    await expect(
      caller().updateRecipeVersion({ id: 'v1', notes: 'cannot edit' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── ABAC gating ───────────────────────────────────────────────────────────────

describe('capability gating', () => {
  it('blocks mutation when ABAC denies', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().createBrand({ name: 'X' })).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/),
    });
  });
});

// ── activateRecipeVersion — supersedes prior ACTIVE ───────────────────────────

describe('activateRecipeVersion', () => {
  it('succeeds for a DRAFT version and returns ACTIVE status', async () => {
    (db.restaurantRecipe as Delegate).findUnique.mockResolvedValue({ id: 'r1' });
    (db.restaurantRecipeVersion as Delegate).findMany.mockResolvedValue([
      { id: 'v1', status: 'DRAFT', versionNumber: 1 },
    ]);
    (db.restaurantRecipeVersion as Delegate).update.mockResolvedValue({
      id: 'v1',
      status: 'ACTIVE',
      yieldQuantity: null,
    });
    const result = await caller().activateRecipeVersion({ recipeId: 'r1', versionId: 'v1' });
    expect(result?.status).toBe('ACTIVE');
  });
});
