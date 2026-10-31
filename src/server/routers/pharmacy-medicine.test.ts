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

describe('#718 non-drug retail catalogue items', () => {
  it('creates a front-shop item with a shop retail price, category and EAN-13 barcode', async () => {
    await caller().createMedicine({
      productName: 'Baby lotion 200ml',
      productFamily: 'FRONT_SHOP',
      presentation: { presentation: 'Bottle, 200 ml' },
      retailPriceMinor: 55_000,
      retailCategory: '  Baby   care ',
      ean13: '4006381333931',
      saleable: true,
    });
    const data = db.medicine.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      productFamily: 'FRONT_SHOP',
      retailPriceMinor: 55_000,
      retailCategory: 'Baby care',
      saleable: true,
      presentations: {
        create: {
          presentation: 'Bottle, 200 ml',
          barcodes: {
            create: { type: 'GTIN', code: '4006381333931', normalizedCode: '4006381333931' },
          },
        },
      },
    });
    expect(data).not.toHaveProperty('ean13');
  });

  it.each([[{ retailPriceMinor: 100 }], [{ retailCategory: 'Cosmetics' }]])(
    'refuses retail fields %j on a medicine',
    async (retail) => {
      await expect(
        caller().createMedicine({
          productName: 'Paracetamol',
          productFamily: 'PHARMACEUTICAL',
          ...retail,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'RETAIL_FIELDS_MEDICINE' });
      expect(db.medicine.create).not.toHaveBeenCalled();
    }
  );

  it('refuses an invalid EAN-13 check digit', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Shampoo',
        productFamily: 'FRONT_SHOP',
        presentation: { presentation: 'Bottle' },
        ean13: '4006381333932',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_EAN13' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('refuses an EAN-13 without a presentation to carry it', async () => {
    await expect(
      caller().createMedicine({
        productName: 'Shampoo',
        productFamily: 'FRONT_SHOP',
        ean13: '4006381333931',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.create).not.toHaveBeenCalled();
  });

  it('keeps a front-shop item saleable without DRAP registration or strength', async () => {
    await caller().createMedicine({
      productName: 'Lip balm',
      productFamily: 'FRONT_SHOP',
      presentation: { presentation: 'Stick' },
      saleable: true,
    });
    expect(db.medicine.create.mock.calls[0]![0].data).toMatchObject({
      retailPriceMinor: null,
      retailCategory: null,
    });
  });
});
