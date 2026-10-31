/**
 * #719 — the shelf-label procedures at the transport layer: the
 * `pharmacy:inventory` capability, the `pharmacy-inventory` module, branch
 * scope from the session, server-owned label content, and an audited print run.
 * The lot identity and counter scan are proved against PostgreSQL in
 * `lib/pharmacy/shelf-label.db.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasModule: vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>(),
}));
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

import { shelfLabelCode } from '@/lib/pharmacy/shelf-label-code';

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });
const CAPABILITY_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You do not have permission for this action.',
};

const lot = {
  id: 'lot_1',
  shelfLabelNumber: 41,
  packLevelId: 'box',
  unitsPerPack: 30,
  printedMrpMinor: 3000,
  receivedExpiresAt: new Date('2027-06-30T19:00:00.000Z'),
  receivedExpiryPrecision: 'MONTH',
  batch: {
    batchNumber: 'B-1',
    medicine: { productName: 'Loose Strip', strengths: [{ value: '500', unit: 'mg' }] },
  },
  packLevel: {
    presentation: {
      packLevels: [
        { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
        { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 3 },
        { id: 'tab', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
      ],
    },
  },
};

function makeDb() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? where.id.in.filter((id) => id === 'branch_a').map((id) => ({ id })) : [{ id: 'branch_a', name: 'Main' }]
      ),
    },
    medicineBarcode: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyGoodsReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyInventoryLot: { findMany: vi.fn().mockResolvedValue([lot]) },
    pharmacyPackPrice: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyStockMovement: { create: vi.fn() },
    pharmacyStockBalance: { update: vi.fn() },
    $transaction: vi.fn(),
  };
}

let db = makeDb();
let audit: { detail: Record<string, unknown> };

function caller(enabledModules = ['pharmacy-inventory']) {
  audit = { detail: {} };
  return pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules,
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user_a', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit,
  } as unknown as TRPCContext);
}

function grant(role: Rule[], overrides: Rule[] = []) {
  db.user.findUnique.mockResolvedValue({
    organizationRole: { permissions: role },
    permissionOverrides: overrides,
  });
}

const printInput = {
  branchId: 'branch_a',
  format: '38x25' as const,
  items: [{ inventoryLotId: 'lot_1', count: 3 }],
};

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('#719 shelf-label procedures', () => {
  it.each([
    ['shelfLabelBranches', undefined],
    ['shelfLabelLots', { branchId: 'branch_a' }],
    ['printShelfLabels', printInput],
  ] as const)('%s requires pharmacy:inventory and honours an explicit DENY', async (procedure, input) => {
    grant([]);
    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    grant([allow('pharmacy:inventory')], [deny('pharmacy:inventory')]);
    await expect(caller()[procedure](input as never)).rejects.toMatchObject(CAPABILITY_REFUSAL);
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['shelfLabelBranches', undefined],
    ['shelfLabelLots', { branchId: 'branch_a' }],
    ['printShelfLabels', printInput],
  ] as const)('%s requires the Pharmacy Inventory module even through a child caller', async (procedure, input) => {
    grant([allow('pharmacy:inventory')]);
    await expect(caller([])[procedure](input as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });

  it('refuses a branch outside this workspace before reading lots', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().printShelfLabels({ ...printInput, branchId: 'branch_other_org' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it('renders labels from server-owned lot data and audits the print run', async () => {
    grant([allow('pharmacy:inventory')]);
    const result = await caller().printShelfLabels(printInput);

    expect(result.total).toBe(3);
    expect(result.html.match(/class="shelf-label"/g)).toHaveLength(3);
    expect(result.html).toContain('MRP/pack: PKR 30.00');
    expect(result.html).toContain('MRP/strip: PKR 10.00');
    expect(result.html).toContain(shelfLabelCode(41));
    const where = db.pharmacyInventoryLot.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      organizationId: 'org_a',
      branchId: 'branch_a',
      id: { in: ['lot_1'] },
    });
    expect(audit.detail).toMatchObject({
      category: 'PHARMACY',
      action: 'shelf_label_print',
      metadata: {
        branchId: 'branch_a',
        format: '38x25',
        totalLabels: 3,
        lots: [{ inventoryLotId: 'lot_1', code: shelfLabelCode(41), count: 3, packMrpMinor: 3000 }],
      },
    });
    // Printing changes neither stock nor prices.
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockBalance.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks barcode ownership at print time and refuses a newly conflicting selection', async () => {
    grant([allow('pharmacy:inventory')]);
    const api = caller();
    const listing = await api.shelfLabelLots({ branchId: 'branch_a' });
    expect(listing.rows[0]).toMatchObject({ inventoryLotId: 'lot_1', unavailableReason: null });

    db.medicineBarcode.findMany.mockResolvedValue([{ normalizedCode: shelfLabelCode(41) }]);
    await expect(api.printShelfLabels(printInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(audit.detail).toEqual({});
    const refreshed = await api.shelfLabelLots({ branchId: 'branch_a' });
    expect(refreshed.rows[0]).toMatchObject({
      inventoryLotId: 'lot_1', count: 0, unavailableReason: expect.stringContaining('already registered'),
    });
  });

  it('refuses client-supplied money, duplicate lots and oversized runs at the boundary', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(
      caller().printShelfLabels({
        ...printInput,
        items: [{ inventoryLotId: 'lot_1', count: 1, packMrpMinor: 1 }],
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().printShelfLabels({
        ...printInput,
        items: [
          { inventoryLotId: 'lot_1', count: 1 },
          { inventoryLotId: 'lot_1', count: 1 },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().printShelfLabels({
        ...printInput,
        items: [
          { inventoryLotId: 'lot_1', count: 2500 },
          { inventoryLotId: 'lot_2', count: 2501 },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().printShelfLabels({ ...printInput, format: 'Letter' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it('lists active branches of the session tenant only', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(caller().shelfLabelBranches()).resolves.toEqual([{ id: 'branch_a', name: 'Main' }]);
    expect(db.pharmacyBranch.findMany.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: 'org_a', active: true },
    });
  });
});
