import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import type { TRPCContext } from '../trpc';

// Real ABAC decision (not mocked): the cashier template's grants come from the role.
function caller(templateKey: string, grants?: string[]) {
  const template = {
    capabilities:
      grants ?? PHARMACY_ROLE_TEMPLATES.find((t) => t.key === templateKey)!.capabilities,
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      })),
    },
    pharmacyRequisition: { findFirst: vi.fn() },
    pharmacyPurchaseOrder: { findFirst: vi.fn() },
    medicine: { create: vi.fn(), findFirst: vi.fn() },
    ingredient: { create: vi.fn() },
    presentation: { findFirst: vi.fn() },
    packLevel: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    medicinePackMrp: { create: vi.fn() },
    medicineBarcode: { create: vi.fn() },
    medicineAlias: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    api: pharmacyMedicineRouter.createCaller(context()),
    purchasing: pharmacyPurchasingRouter.createCaller(context()),
  };

  function context() {
    return {
      db,
      entitlements: { organizationId: 'org_a', enabledModules: ['pharmacy-core'], modules: [] },
      session: {
        expires: 'later',
        user: {
          id: `${templateKey}_1`,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationId: 'org_a',
        },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext;
  }
}

describe('createMedicine requires pharmacy:procurement on the server (#132)', () => {
  it('refuses a cashier', async () => {
    const { api, db } = caller('cashier');
    await expect(
      api.createMedicine({ productName: 'Test', productFamily: 'FRONT_SHOP' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicine.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // Canonical colon grant (#163 renames the templates; until it merges, dotted template
  // grants do not satisfy this gate).
  it('lets a pharmacy:procurement holder past the gate (positive control)', async () => {
    const { api, db } = caller('procurement', ['pharmacy:procurement']);
    await api
      .createMedicine({ productName: 'Test', productFamily: 'FRONT_SHOP' })
      .catch(() => null);
    expect(db.medicine.create).toHaveBeenCalled();
  });
});

describe('catalogue write procedures require pharmacy:procurement (#173 security)', () => {
  const at = new Date('2026-10-01');
  const calls: Array<[string, (api: ReturnType<typeof caller>['api']) => Promise<unknown>]> = [
    ['createIngredient', (api) => api.createIngredient({ name: 'Paracetamol' })],
    [
      'createPackLevel',
      (api) =>
        api.createPackLevel({
          presentationId: 'p1',
          versionGroupId: 'g1',
          level: 'BOX',
          unitsPerParent: 1,
          effectiveFrom: at,
        }),
    ],
    [
      'revisePackLevel',
      (api) => api.revisePackLevel({ id: 'l1', unitsPerParent: 2, effectiveFrom: at }),
    ],
    [
      'recordPrintedMrp',
      (api) =>
        api.recordPrintedMrp({ packLevelId: 'l1', batchReference: 'B1', printedMrpMinor: 100 }),
    ],
    ['addBarcode', (api) => api.addBarcode({ presentationId: 'p1', type: 'GTIN', code: '123' })],
    ['addAlias', (api) => api.addAlias({ medicineId: 'm1', type: 'BRAND', value: 'Panadol' })],
  ];

  it.each(calls)('refuses a cashier on %s before any write', async (_name, call) => {
    const { api, db } = caller('cashier');
    await expect(call(api)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.ingredient.create).not.toHaveBeenCalled();
    expect(db.packLevel.create).not.toHaveBeenCalled();
    expect(db.packLevel.findFirst).not.toHaveBeenCalled();
    expect(db.presentation.findFirst).not.toHaveBeenCalled();
    expect(db.medicinePackMrp.create).not.toHaveBeenCalled();
    expect(db.medicineBarcode.create).not.toHaveBeenCalled();
    expect(db.medicineAlias.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('lets a procurement holder reach createIngredient', async () => {
    const { api, db } = caller('procurement', ['pharmacy:procurement']);
    await api.createIngredient({ name: 'Paracetamol' }).catch(() => null);
    expect(db.ingredient.create).toHaveBeenCalled();
  });

  it('scopes the createPackLevel nesting lookups to the organization', async () => {
    const { api, db } = caller('procurement', ['pharmacy:procurement']);
    db.presentation.findFirst.mockResolvedValue({ id: 'p1' } as never);
    db.packLevel.findFirst.mockResolvedValue({ id: 'parent' } as never);
    await api
      .createPackLevel({
        presentationId: 'p1',
        parentPackLevelId: 'parent',
        versionGroupId: 'g1',
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: at,
      })
      .catch(() => null);
    expect(db.presentation.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', organizationId: 'org_a' },
    });
    expect(db.packLevel.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'parent',
        organizationId: 'org_a',
        presentationId: 'p1',
      }),
    });
  });
});

describe('revisePackLevel locks, closes under the lock and carries children forward (#173 security)', () => {
  type Level = {
    id: string;
    organizationId: string;
    presentationId: string;
    parentPackLevelId: string | null;
    versionGroupId: string;
    version: number;
    level: string;
    unitsPerParent: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  };
  const from = new Date('2026-01-01');
  const at = new Date('2026-10-01');
  function setup() {
    const { api, db } = caller('procurement', ['pharmacy:procurement']);
    const levels: Level[] = [
      ['box', null, 'BOX', 1],
      ['strip', 'box', 'STRIP', 10],
      ['unit', 'strip', 'UNIT', 10],
    ].map(([id, parent, level, units]) => ({
      id: id as string,
      organizationId: 'org_a',
      presentationId: 'p1',
      parentPackLevelId: parent as string | null,
      versionGroupId: `g-${id}`,
      version: 1,
      level: level as string,
      unitsPerParent: units as number,
      effectiveFrom: from,
      effectiveTo: null,
    }));
    const locks: string[] = [];
    let n = 0;
    const match = (row: Level, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key as keyof Level] === value);
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('FOR UPDATE')) locks.push(values[0] as string);
        return [];
      }),
      packLevel: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const row = levels.find((l) => match(l, where));
          return row ? { ...row } : null;
        }),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          levels.filter((l) => match(l, where)).map((l) => ({ ...l }))
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Partial<Level> }) => {
            const rows = levels.filter((l) => match(l, where));
            rows.forEach((row) => Object.assign(row, data));
            return { count: rows.length };
          }
        ),
        create: vi.fn(async ({ data }: { data: Omit<Level, 'id' | 'organizationId'> }) => {
          const row = { ...data, id: `v2-${++n}`, organizationId: 'org_a', effectiveTo: null };
          levels.push(row as Level);
          return row;
        }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (t: unknown) => unknown) => callback(tx));
    return { api, levels, locks, tx };
  }

  it('closes the revised level and every descendant, re-parenting children onto new versions', async () => {
    const { api, levels, locks } = setup();
    const next = await api.revisePackLevel({ id: 'box', unitsPerParent: 1, effectiveFrom: at });
    expect(locks).toEqual(['box', 'strip', 'unit']);
    for (const id of ['box', 'strip', 'unit'])
      expect(levels.find((l) => l.id === id)!.effectiveTo).toEqual(at);
    const open = levels.filter((l) => l.effectiveTo === null);
    expect(open).toHaveLength(3);
    const strip = open.find((l) => l.level === 'STRIP')!;
    const unit = open.find((l) => l.level === 'UNIT')!;
    expect(strip.parentPackLevelId).toBe((next as { id: string }).id);
    expect(unit.parentPackLevelId).toBe(strip.id);
    expect(strip.unitsPerParent).toBe(10);
    expect(unit.unitsPerParent).toBe(10);
  });

  it('applies the new multiplier only to the revised level', async () => {
    const { api, levels } = setup();
    await api.revisePackLevel({ id: 'strip', unitsPerParent: 14, effectiveFrom: at });
    const open = levels.filter((l) => l.effectiveTo === null);
    expect(open.find((l) => l.level === 'STRIP')!.unitsPerParent).toBe(14);
    expect(open.find((l) => l.level === 'STRIP')!.parentPackLevelId).toBe('box');
    expect(open.find((l) => l.level === 'UNIT')!.unitsPerParent).toBe(10);
  });

  it('refuses a second revision of an already-closed level with CONFLICT', async () => {
    const { api, tx } = setup();
    await api.revisePackLevel({ id: 'unit', unitsPerParent: 12, effectiveFrom: at });
    const creates = tx.packLevel.create.mock.calls.length;
    await expect(
      api.revisePackLevel({ id: 'unit', unitsPerParent: 8, effectiveFrom: new Date('2026-11-01') })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.packLevel.create.mock.calls.length).toBe(creates);
  });
});

describe('purchasing lifecycle requires pharmacy:procurement', () => {
  const calls: Array<[string, (api: ReturnType<typeof caller>['purchasing']) => Promise<unknown>]> =
    [
      ['submitRequisition', (api) => api.submitRequisition({ requisitionId: 'r1' })],
      ['submitPurchaseOrder', (api) => api.submitPurchaseOrder({ purchaseOrderId: 'po1' })],
      [
        'approvePurchaseOrder',
        (api) => api.approvePurchaseOrder({ purchaseOrderId: 'po1', decision: 'APPROVED' }),
      ],
      ['sendPurchaseOrder', (api) => api.sendPurchaseOrder({ purchaseOrderId: 'po1' })],
      [
        'postGoodsReceipt',
        (api) => api.postGoodsReceipt({ branchId: 'b1', goodsReceiptId: 'gr1' }),
      ],
    ];

  it.each(calls)(
    'refuses a cashier on %s before accessing purchasing data',
    async (_name, call) => {
      const { purchasing, db } = caller('cashier');
      await expect(call(purchasing)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyRequisition.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyPurchaseOrder.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(calls.filter(([name]) => name !== 'postGoodsReceipt'))(
    'allows a procurement grant past the gate on %s',
    async (_name, call) => {
      const { purchasing, db } = caller('procurement', ['pharmacy:procurement']);
      await call(purchasing).catch((error: { code: string }) => {
        expect(error.code).not.toBe('FORBIDDEN');
      });
      expect(
        db.pharmacyRequisition.findFirst.mock.calls.length +
          db.pharmacyPurchaseOrder.findFirst.mock.calls.length +
          db.$transaction.mock.calls.length
      ).toBeGreaterThan(0);
    }
  );
});
