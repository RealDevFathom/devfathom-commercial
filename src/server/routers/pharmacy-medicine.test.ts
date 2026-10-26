import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  return { hasModule };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';
import { moduleForProcedure } from '@/lib/module-catalog';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
  };
}

function makeDb() {
  const db = {
    ingredient: model(),
    medicine: model(),
    presentation: model(),
    packLevel: model(),
    medicinePackMrp: model(),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();
function caller(enabledModules = ['pharmacy-core']) {
  return pharmacyMedicineRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules,
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: 'user_a', role: 'ADMIN', status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('pharmacy medicine tenant and entitlement boundaries', () => {
  it('rejects a cross-tenant ingredient ID substitution', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: [{ ingredientId: 'ingredient_from_org_b', value: 500, unit: 'mg' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects oversized medicine collections before database work', async () => {
    const strength = { ingredientId: 'ingredient_a', value: 500, unit: 'mg' };
    const assertion = {
      field: 'productName',
      source: 'manual',
      sourceType: 'USER' as const,
      retrievedAt: new Date('2026-01-01'),
      status: 'UNREVIEWED' as const,
    };

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: Array.from({ length: 21 }, () => strength),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: Array.from({ length: 21 }, () => assertion),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.ingredient.findFirst).not.toHaveBeenCalled();
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('accepts medicine collections and ingredient IDs at their limits', async () => {
    const ingredientId = 'i'.repeat(200);
    db.ingredient.findFirst.mockResolvedValue({ id: ingredientId });
    const assertion = {
      field: 'productName',
      source: 'manual',
      sourceType: 'USER' as const,
      retrievedAt: new Date('2026-01-01'),
      status: 'UNREVIEWED' as const,
    };

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: Array.from({ length: 20 }, () => ({
          ingredientId,
          value: 500,
          unit: 'mg',
        })),
        provenance: Array.from({ length: 20 }, () => assertion),
      })
    ).resolves.toMatchObject({ id: 'new' });

    expect(db.ingredient.findFirst).toHaveBeenCalledTimes(20);
    expect(db.medicine.create).toHaveBeenCalledOnce();
  });

  it('rejects an oversized ingredient ID before database work', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        strengths: [{ ingredientId: 'x'.repeat(201), value: 500, unit: 'mg' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.ingredient.findFirst).not.toHaveBeenCalled();
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects oversized assertion publication before opening a transaction', async () => {
    await expect(
      caller().publishAssertions({
        assertionIds: Array.from({ length: 21 }, (_, index) => `assertion_${index}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().publishAssertions({ assertionIds: ['x'.repeat(201)] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant presentation ID substitution', async () => {
    await expect(
      caller().createPackLevel({
        presentationId: 'presentation_from_org_b',
        versionGroupId: 'box',
        level: 'BOX',
        unitsPerParent: 20,
        effectiveFrom: new Date('2030-01-01'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.packLevel.create).not.toHaveBeenCalled();
  });

  it('maps the public router prefix to the pharmacy-core entitlement', () => {
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });
});
