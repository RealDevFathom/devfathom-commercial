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
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org_a',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:catalogue-review', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
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

describe('catalogue mutation authorization', () => {
  const calls = [
    (c: ReturnType<typeof caller>) => c.createIngredient({ name: 'ingredient' }),
    (c: ReturnType<typeof caller>) =>
      c.createMedicine({
        productName: 'front shop',
        productFamily: 'FRONT_SHOP',
        rx: false,
        controlled: false,
      }),
    (c: ReturnType<typeof caller>) =>
      c.createPackLevel({
        presentationId: 'p',
        versionGroupId: 'g',
        level: 'BOX',
        unitsPerParent: 10,
        effectiveFrom: new Date(),
      }),
    (c: ReturnType<typeof caller>) =>
      c.revisePackLevel({ id: 'pack', unitsPerParent: 100, effectiveFrom: new Date() }),
  ];
  it.each(calls.map((call, index) => ({ call, index })))(
    'denies unprivileged mutation $index before any domain access',
    async ({ call }) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
        permissionOverrides: [],
      });
      await expect(call(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const model of [db.ingredient, db.medicine, db.presentation, db.packLevel]) {
        expect(model.findFirst).not.toHaveBeenCalled();
        expect(model.create).not.toHaveBeenCalled();
        expect(model.update).not.toHaveBeenCalled();
      }
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );
  it('allows catalogue reviewers to create medicines and ingredients and version packs', async () => {
    db.presentation.findFirst.mockResolvedValue({ id: 'p' } as never);
    db.packLevel.findFirst.mockResolvedValue({
      id: 'pack',
      presentationId: 'p',
      versionGroupId: 'g',
      level: 'BOX',
      version: 1,
    } as never);
    for (const call of calls) await call(caller());
    expect(db.ingredient.create).toHaveBeenCalledOnce();
    expect(db.medicine.create).toHaveBeenCalledOnce();
    expect(db.packLevel.create).toHaveBeenCalledTimes(2);
    expect(db.packLevel.update).toHaveBeenCalledOnce();
  });
});
