/** Real Prisma predicates and tenant RLS; requires a migrated TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async (subject: { id: string }, action: string) =>
    action === 'restaurant:configure' ? subject.id.endsWith('_owner') : action === 'inventory:read'
  ),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_inventory_reads_${suffix}`;
const otherOrgId = `org_inventory_reads_other_${suffix}`;
const id = (name: string, organizationId = orgId) => `${organizationId}_${name}`;

let scoped: typeof import('@/lib/tenancy/scoped-db');
let inventory: typeof import('./inventory');
let router: typeof import('@/server/routers/restaurant-inventory');
let ledger: typeof import('./inventory-ledger');

async function seed(organizationId: string) {
  const key = (name: string) => id(name, organizationId);
  await scoped.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: 'Inventory read scope test',
        displayName: 'Inventory read scope test',
        status: 'ACTIVE',
      },
    })
  );
  await scoped.withTenantDb(
    organizationId,
    async (tx) => {
      await tx.organizationDepartment.create({
        data: { key: 'ops', name: 'Operations' },
      });
      await tx.restaurantUnit.create({
        data: { id: key('unit'), name: 'Each', abbreviation: 'ea' },
      });
      await tx.restaurantIngredient.create({
        data: { id: key('ingredient'), name: 'Flour', baseUnitId: key('unit') },
      });
      await tx.restaurantStockItem.create({
        data: {
          id: key('item'),
          ingredientId: key('ingredient'),
          canonicalUnitId: key('unit'),
          trackBatches: true,
        },
      });
      for (const branch of ['a', 'b', 'c', 'inactive']) {
        await tx.restaurantBranch.create({
          data: { id: key(branch), name: branch, active: branch !== 'inactive' },
        });
        await tx.restaurantStockLocation.create({
          data: { id: key(`location_${branch}`), branchId: key(branch), name: branch },
        });
        await tx.restaurantStockBatch.create({
          data: { id: key(`batch_${branch}`), stockItemId: key('item'), code: branch },
        });
        await ledger.postStockMovements(tx, {
          movements: [
            {
              stockItemId: key('item'),
              locationId: key(`location_${branch}`),
              batchId: key(`batch_${branch}`),
              reason: 'MANUAL_CORRECTION',
              quantity: '10',
            },
          ],
        });
        await tx.restaurantStockCount.create({
          data: { id: key(`count_${branch}`), locationId: key(`location_${branch}`) },
        });
        await inventory.createLowStockRule(tx, {
          stockItemId: key('item'),
          locationId: key(`location_${branch}`),
          threshold: '20',
        });
      }
      for (const persona of ['reader', 'owner']) {
        await tx.user.create({
          data: {
            id: key(persona),
            name: persona,
            email: `${key(persona)}@test.invalid`,
            department: 'ops',
            title: 'Inventory operator',
          },
        });
        await tx.restaurantStaffProfile.create({
          data: {
            userId: key(persona),
            displayName: persona,
            primaryBranchId: key('a'),
          },
        });
      }
      for (const branch of ['b', 'inactive']) {
        await tx.restaurantBranchAssignment.create({
          data: { userId: key('reader'), branchId: key(branch) },
        });
      }
      for (const [source, destination] of [
        ['a', 'b'],
        ['a', 'c'],
        ['c', 'b'],
        ['a', 'inactive'],
      ]) {
        await tx.restaurantStockTransfer.create({
          data: {
            id: key(`transfer_${source}_${destination}`),
            sourceLocationId: key(`location_${source}`),
            destinationLocationId: key(`location_${destination}`),
          },
        });
      }
      await tx.restaurantSupplier.create({ data: { id: key('supplier'), name: 'Supplier' } });
      await tx.restaurantPurchaseReceipt.create({
        data: {
          id: key('receipt_c'),
          supplierId: key('supplier'),
          branchId: key('c'),
          locationId: key('location_c'),
        },
      });
      await tx.restaurantStockBatch.create({
        data: {
          id: key('batch_transferred'),
          stockItemId: key('item'),
          code: 'Transferred from C',
          receiptId: key('receipt_c'),
        },
      });
      await ledger.postStockMovements(tx, {
        movements: [
          {
            stockItemId: key('item'),
            locationId: key('location_c'),
            batchId: key('batch_transferred'),
            receiptId: key('receipt_c'),
            reason: 'PURCHASE_RECEIPT',
            quantity: '5',
          },
          ...(['c', 'b'] as const).map((branch) => ({
            stockItemId: key('item'),
            locationId: key(`location_${branch}`),
            batchId: key('batch_transferred'),
            transferId: key('transfer_c_b'),
            reason: 'TRANSFER' as const,
            quantity: branch === 'c' ? '-5' : '5',
          })),
        ],
      });
      // Neither a branchless batch nor a receipt alone grants branch visibility.
      await tx.restaurantStockBatch.create({
        data: { stockItemId: key('item'), code: 'No branch history' },
      });
      await tx.restaurantStockBatch.create({
        data: { stockItemId: key('item'), code: 'Receipt only', receiptId: key('receipt_c') },
      });
    },
    { timeout: 30_000 }
  );
}

function caller(db: ScopedDb, persona: 'reader' | 'owner' = 'reader') {
  return router.restaurantInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: orgId,
      enabledModules: ['restaurant-pos'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
    },
    session: {
      expires: 'later',
      user: {
        id: id(persona),
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        department: 'ops',
        organizationId: orgId,
      },
    },
    organization: { id: orgId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

type InventoryCaller = ReturnType<typeof caller>;
const readers = [
  {
    name: 'on hand',
    read: async (api: InventoryCaller) =>
      (await api.listStockOnHand({})).map((row) => row.locationId),
    kind: 'location',
  },
  {
    name: 'movements',
    read: async (api: InventoryCaller) =>
      (await api.listStockMovements({})).items.map((row) => row.locationId),
    kind: 'location',
  },
  {
    name: 'counts',
    read: async (api: InventoryCaller) =>
      (await api.listStockCounts({})).items.map((row) => row.locationId),
    kind: 'location',
  },
  {
    name: 'low stock',
    read: async (api: InventoryCaller) =>
      (await api.evaluateLowStockRules({})).map((row) => row.locationId),
    kind: 'location',
  },
  {
    name: 'transfers',
    read: async (api: InventoryCaller) =>
      (await api.listStockTransfers({})).items.map((row) => row.id),
    kind: 'transfer',
  },
  {
    name: 'batches',
    read: async (api: InventoryCaller) =>
      (await api.listStockBatches({})).items.map((row) => row.id),
    kind: 'batch',
  },
];

describeWithDatabase('inventory read branch scope (real PostgreSQL)', () => {
  beforeAll(async () => {
    [scoped, inventory, router, ledger] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./inventory'),
      import('@/server/routers/restaurant-inventory'),
      import('./inventory-ledger'),
    ]);
    await seed(orgId);
    await seed(otherOrgId);
  }, 60_000);

  it.each(readers)(
    '$name includes primary/assigned branches and excludes unassigned/inactive/foreign branches',
    async ({ read, kind }) => {
      await scoped.withTenantDb(orgId, async (tx) => {
        const expected =
          kind === 'location'
            ? ['location_a', 'location_b']
            : kind === 'transfer'
              ? ['transfer_a_b']
              : ['batch_a', 'batch_b', 'batch_transferred'];
        expect([...new Set(await read(caller(tx)))].sort()).toEqual(
          expected.map((key) => id(key)).sort()
        );
      });
    }
  );

  it.each(readers)(
    '$name lets a configure/solo-owner reader see every active branch in this tenant',
    async ({ read, kind }) => {
      await scoped.withTenantDb(orgId, async (tx) => {
        const expected =
          kind === 'location'
            ? ['location_a', 'location_b', 'location_c']
            : kind === 'transfer'
              ? ['transfer_a_b', 'transfer_a_c', 'transfer_c_b']
              : ['batch_a', 'batch_b', 'batch_c', 'batch_transferred'];
        expect([...new Set(await read(caller(tx, 'owner')))].sort()).toEqual(
          expected.map((key) => id(key)).sort()
        );
      });
    }
  );

  it('keeps explicit location/branch filters inside the derived branch scope', async () => {
    await scoped.withTenantDb(orgId, async (tx) => {
      const api = caller(tx);
      for (const locationId of [
        id('location_c'),
        id('location_inactive'),
        id('location_a', otherOrgId),
      ]) {
        expect(await api.listStockOnHand({ locationId })).toEqual([]);
        expect((await api.listStockMovements({ locationId })).items).toEqual([]);
        expect((await api.listStockCounts({ locationId })).items).toEqual([]);
        expect(await api.evaluateLowStockRules({ locationId })).toEqual([]);
      }
      expect(
        await api.listStockOnHand({ branchId: id('c'), locationId: id('location_a') })
      ).toEqual([]);
      expect((await api.listStockTransfers({ sourceLocationId: id('location_c') })).items).toEqual(
        []
      );
      expect(
        (await api.listStockTransfers({ destinationLocationId: id('location_c') })).items
      ).toEqual([]);
    });
  });

  it('retains depleted source-branch batch metadata for historical ledger reads', async () => {
    await scoped.withTenantDb(orgId, async (tx) => {
      const batches = await inventory.listStockBatches(tx, { branchIds: [id('c')] });
      expect(batches.items.map((row) => row.id).sort()).toEqual(
        [id('batch_c'), id('batch_transferred')].sort()
      );
      const balance = await ledger.deriveBalances(tx, {
        stockItemIds: [id('item')],
        locationIds: [id('location_c')],
        byBatch: true,
      });
      expect(
        balance.find((row) => row.batchId === id('batch_transferred'))?.onHand.toString()
      ).toBe('0');
    });
  });

  it('fails closed for an explicitly empty branch scope in all six helpers', async () => {
    await scoped.withTenantDb(orgId, async (tx) => {
      const filter = { branchIds: [] };
      expect(await inventory.listStockOnHand(tx, filter)).toEqual([]);
      expect(await inventory.evaluateLowStockRules(tx, filter)).toEqual([]);
      expect((await inventory.listStockMovements(tx, filter)).items).toEqual([]);
      expect((await inventory.listStockCounts(tx, filter)).items).toEqual([]);
      expect((await inventory.listStockTransfers(tx, filter)).items).toEqual([]);
      expect((await inventory.listStockBatches(tx, filter)).items).toEqual([]);
    });
  });
});
