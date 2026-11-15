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
    user: {
      findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
    },
    ingredient: model(),
    medicine: model(),
    presentation: model(),
    packLevel: model(),
    medicinePackMrp: model(),
    medicineBarcode: model(),
    medicineAlias: model(),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();
function caller(enabledModules = ['pharmacy-core'], role = 'ADMIN') {
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
    session: { expires: 'later', user: { id: 'user_a', role, status: 'ACTIVE' } },
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

const catalogueEdits = [
  ['createIngredient', { name: 'Paracetamol' }, 'ingredient'],
  ['createMedicine', { productName: 'Medicine', productFamily: 'PHARMACEUTICAL' }, 'medicine'],
  [
    'createPackLevel',
    {
      presentationId: 'presentation_a',
      versionGroupId: 'box',
      level: 'BOX',
      unitsPerParent: 20,
      effectiveFrom: new Date('2030-01-01'),
    },
    'packLevel',
  ],
  [
    'revisePackLevel',
    { id: 'pack_a', unitsPerParent: 30, effectiveFrom: new Date('2030-01-01') },
    'packLevel',
  ],
  [
    'recordPrintedMrp',
    { packLevelId: 'pack_a', batchReference: 'B1', printedMrpMinor: 1000 },
    'medicinePackMrp',
  ],
  [
    'addBarcode',
    { presentationId: 'presentation_a', type: 'GTIN', code: '123' },
    'medicineBarcode',
  ],
  ['addAlias', { medicineId: 'medicine_a', type: 'BRAND', value: 'Panadol' }, 'medicineAlias'],
] as const;

describe('catalogue edits require catalogue administration (DEV-19)', () => {
  it.each(catalogueEdits)(
    'refuses a cashier %s before any catalogue write',
    async (name, input, model) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
            { capability: 'pharmacy:orders', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      });
      db.presentation.findFirst.mockResolvedValue({ id: 'presentation_a' });
      db.packLevel.findFirst.mockResolvedValue({ id: 'pack_a', version: 1 });
      const procedure = caller(['pharmacy-core'], 'EMPLOYEE')[name] as (
        value: typeof input
      ) => Promise<unknown>;

      await expect(procedure(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db[model].create).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a pharmacy-wide role grant that lacks catalogue administration', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });

    await expect(
      caller(['pharmacy-core'], 'EMPLOYEE').addAlias({
        medicineId: 'medicine_a',
        type: 'BRAND',
        value: 'Panadol',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicineAlias.create).not.toHaveBeenCalled();
  });

  it('lets a catalogue administrator add an alias', async () => {
    await expect(
      caller().addAlias({ medicineId: 'medicine_a', type: 'BRAND', value: 'Panadol' })
    ).resolves.toMatchObject({ id: 'new', normalizedValue: expect.any(String) });
  });

  it.each(['ACCEPTED', 'CORRECTED', 'REJECTED'])(
    'refuses a new medicine whose author declares its own %s review',
    async (status) => {
      await expect(
        caller().createMedicine({
          productName: 'Medicine',
          productFamily: 'PHARMACEUTICAL',
          provenance: [
            {
              field: 'productName',
              source: 'manual',
              sourceType: 'USER',
              retrievedAt: new Date('2026-01-01'),
              status: status as 'UNREVIEWED',
            },
          ],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.medicine.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a self-named reviewer and direct publication on creation', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            reviewer: 'user_a',
          } as never,
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'FRONT_SHOP',
        saleable: true as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('creates a new medicine as an unreviewed, unsaleable review candidate', async () => {
    await expect(
      caller().createMedicine({ productName: 'Medicine', productFamily: 'FRONT_SHOP' })
    ).resolves.toMatchObject({ id: 'new', saleable: false });
  });
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

  it.each([
    ['string', 'x'.repeat(2_000)],
    ['array', Array.from({ length: 20 }, () => 'value')],
    [
      'object and keys',
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [String(index).padStart(100, 'k'), index])
      ),
    ],
    ['nesting', [[[['value']]]]],
    [
      'aggregate nodes',
      Array.from({ length: 20 }, (_, row) =>
        Array.from({ length: 20 }, (_, column) =>
          Array.from({ length: row * 20 + column < 179 ? 2 : 1 }, () => null)
        )
      ),
    ],
    ['aggregate characters', Array.from({ length: 10 }, () => 'x'.repeat(2_000))],
  ])('persists a provenance assertedValue at the %s limit', async (_, value) => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: value,
          },
        ],
      })
    ).resolves.toMatchObject({ id: 'new' });

    expect(db.medicine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provenance: { create: [expect.objectContaining({ assertedValue: value })] },
        }),
      })
    );
  });

  it.each([
    ['string', 'x'.repeat(2_001)],
    ['array', Array.from({ length: 21 }, () => 'value')],
    [
      'object',
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, index])),
    ],
    ['nesting', [[[[['too deep']]]]]],
  ])('rejects an oversized provenance assertedValue %s before database work', async (_, value) => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: value,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects provenance assertedValue trees over the aggregate node budget', async () => {
    const leaves = Array.from({ length: 20 }, () => 'value');
    const branch = Array.from({ length: 20 }, () => leaves);
    const broadTree = Array.from({ length: 20 }, () => branch);

    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: broadTree,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('rejects provenance assertedValue trees over the aggregate character budget', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Medicine',
        productFamily: 'PHARMACEUTICAL',
        provenance: [
          {
            field: 'productName',
            source: 'manual',
            sourceType: 'USER',
            retrievedAt: new Date('2026-01-01'),
            status: 'UNREVIEWED',
            assertedValue: Array.from({ length: 11 }, () => 'x'.repeat(2_000)),
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.create).not.toHaveBeenCalled();
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

  it('rejects oversized review decision IDs before opening a transaction', async () => {
    const oversizedId = 'x'.repeat(201);

    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'ACCEPT',
        medicineIds: [oversizedId],
        payload: { assertionIds: ['assertion'] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'ACCEPT',
        medicineIds: ['medicine'],
        payload: { assertionIds: [oversizedId] },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'CORRECT',
        medicineIds: ['medicine'],
        payload: {
          assertionIds: ['assertion'],
          corrections: [{ assertionId: oversizedId, value: 'corrected' }],
        },
      })
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
