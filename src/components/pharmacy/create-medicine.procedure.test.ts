import { expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({ hasModule: vi.fn(() => true) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: guards.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import { router, type TRPCContext } from '@/server/trpc';
import { purchasingWorkspace } from '@/lib/pharmacy/purchasing-console';
import { searchCounterCatalog } from '@/lib/pharmacy/counter';
import { receiveLot } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

function caller(db: object) {
  return router({ pharmacyMedicine: pharmacyMedicineRouter }).createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: { expires: 'later', user: { id: 'admin-a', role: 'ADMIN', status: 'ACTIVE' } },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyMedicine;
}
import { evaluatePharmacyReadiness } from '@/lib/pharmacy/onboarding';
import type { PrismaClient } from '@/generated/prisma/client';

it('creates, reviews, publishes and packs a manual medicine through stock-in and counter sellable stock, including onboarding step 8 (in-memory delegates)', async () => {
  type Assertion = {
    id: string;
    medicineId: string;
    status: string;
    reviewer?: string;
    field: string;
    assertedValue: unknown;
  };
  let assertions: Assertion[] = [];
  let medicine = {
    id: 'manual-med',
    organizationId: 'org-a',
    productName: 'Paracetamol',
    productFamily: 'PHARMACEUTICAL',
    saleable: false,
  };
  const decisions: object[] = [];
  const packs: { id: string; parentPackLevelId: string | null }[] = [];
  const entries: object[] = [];
  let published = false;
  const at = new Date('2026-10-21T12:00:00Z');
  const expiresAt = new Date('2027-12-31T23:59:59Z');
  const batch = {
    id: 'manual-manufacturing-batch',
    medicineId: medicine.id,
    batchNumber: 'MANUAL-001',
    state: 'ACTIVE',
    expiresAt,
    medicine: { coldChain: false },
  };
  const location = {
    id: 'shelf-a',
    branchId: 'branch-a',
    coldChain: false,
    kind: 'SHELF',
    code: 'A',
    name: 'Shelf A',
  };
  const lots: object[] = [];
  const balances: object[] = [];
  const db = {
    medicine: {
      create: vi.fn(async ({ data }: { data: { provenance: { create: Assertion[] } } }) => {
        assertions = data.provenance.create.map((p, i) => ({
          ...p,
          id: `assertion-${i}`,
          medicineId: medicine.id,
        }));
        return { ...medicine, provenance: assertions, presentations: [], strengths: [] };
      }),
      count: vi.fn(async () => 1),
      findUniqueOrThrow: vi.fn(async () => medicine),
      update: vi.fn(
        async ({ data }: { data: Partial<typeof medicine> }) =>
          (medicine = { ...medicine, ...data })
      ),
      findMany: vi.fn(async () =>
        medicine.saleable
          ? [
              {
                ...medicine,
                coldChain: false,
                strengths: [],
                controlled: false,
                presentations: [
                  { id: 'manual-presentation', presentation: '10 tablets', packLevels: packs },
                ],
              },
            ]
          : []
      ),
    },
    medicineProvenance: {
      // Append-only like the DB trigger: no update/updateMany delegate exists.
      findMany: vi.fn(
        async ({ where }: { where?: { id?: { in: string[] }; supersededBy?: object } } = {}) =>
          assertions.filter(
            (p) =>
              (!where?.id || where.id.in.includes(p.id)) &&
              (!where?.supersededBy ||
                !assertions.some((q) => (q as { supersedesId?: string }).supersedesId === p.id))
          )
      ),
      count: vi.fn(async ({ where }: { where: { supersedesId: { in: string[] } } }) =>
        assertions.filter((p) =>
          where.supersedesId.in.includes((p as { supersedesId?: string }).supersedesId ?? '')
        ).length
      ),
      create: vi.fn(async ({ data }: { data: Assertion }) => {
        const row = { ...data, id: `reviewed-${assertions.length}` } as Assertion;
        assertions = [...assertions, row];
        return row;
      }),
    },
    medicineReviewDecision: {
      create: vi.fn(async ({ data }: { data: object }) => {
        decisions.push(data);
        return data;
      }),
      findMany: vi.fn(async () => decisions),
    },
    medicinePublicationEntry: {
      findFirst: vi.fn(async () => null),
      createMany: vi.fn(async ({ data }: { data: object[] }) => {
        entries.push(...data);
        return { count: data.length };
      }),
      count: vi.fn(async () => (published && medicine.saleable ? entries.length : 0)),
    },
    medicinePublicationBatch: {
      create: vi.fn(async () => ({ id: 'manual-batch' })),
      update: vi.fn(async () => {
        published = true;
        return { id: 'manual-batch', status: 'PUBLISHED' };
      }),
    },
    ingredient: { upsert: vi.fn(async () => ({ id: 'manual-ingredient' })) },
    presentation: {
      create: vi.fn(async () => ({ id: 'manual-presentation' })),
      findFirst: vi.fn(async () => ({ id: 'manual-presentation' })),
      findMany: vi.fn(async () => []),
    },
    medicineStrengthComponent: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    medicineAlias: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    medicineBarcode: { findFirst: vi.fn(async () => null) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    packLevel: {
      findMany: vi.fn(async () => packs),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          packs.find((pack) => pack.id === where.id) ?? null
      ),
      create: vi.fn(async ({ data }: { data: { parentPackLevelId?: string } }) => {
        const pack = {
          ...data,
          id: `manual-pack-${packs.length}`,
          parentPackLevelId: data.parentPackLevelId ?? null,
          effectiveTo: null,
        };
        packs.push(pack);
        return pack;
      }),
    },
    pharmacyBranch: { findMany: vi.fn(async () => []) },
    pharmacyStockLocation: {
      findMany: vi.fn(async () => [location]),
      findFirst: vi.fn(async () => location),
    },
    pharmacySupplier: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    user: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      })),
    },
    organization: { findUnique: vi.fn(async () => null) },
    pharmacyOnboardingGateState: { findMany: vi.fn(async () => []) },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => null) },
    organizationRole: { count: vi.fn(async () => 0) },
    pharmacyManufacturingBatch: { findFirst: vi.fn(async () => batch) },
    pharmacyInventoryLot: {
      count: vi.fn(async () => lots.length),
      create: vi.fn(async ({ data }: { data: object }) => {
        const lot = { id: 'manual-lot', ...data, batch };
        lots.push(lot);
        return lot;
      }),
      findMany: vi.fn(async () => lots),
    },
    pharmacyStockMovement: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            inventoryLotId: string;
            stockLocationId: string;
            disposition: string;
            quantityUnits: number;
          };
        }) => {
          // Emulate only the receipt balance projection; real trigger behavior belongs to DB tests.
          balances.push({
            inventoryLotId: data.inventoryLotId,
            stockLocationId: data.stockLocationId,
            disposition: data.disposition,
            onHandUnits: data.quantityUnits,
          });
          return { id: 'manual-receipt', ...data };
        }
      ),
    },
    pharmacyStockBalance: { findMany: vi.fn(async () => balances) },
  };
  const scoped = Object.assign(db, {
    $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
    $queryRaw: vi.fn(async () => []),
  });
  const api = caller(scoped);
  const readiness = () => evaluatePharmacyReadiness(scoped as unknown as PrismaClient, 'org-a');
  const gate = (result: Awaited<ReturnType<typeof readiness>>) =>
    result.gates.find((g) => g.gate === 'MEDICINE_CATALOG_READINESS');
  expect(gate(await readiness())?.status).not.toBe('PASSED');
  await api.createMedicine({
    productName: 'Paracetamol',
    productFamily: 'PHARMACEUTICAL',
    saleable: false,
    provenance: Object.entries({
      productName: 'Paracetamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      pack: '10 tablets',
      drapRegistrationNumber: 'REG-123',
      alias: 'Paracetamol',
    }).map(([field, value]) => ({
      field,
      source: 'Pack and registration record',
      sourceType: 'USER',
      status: 'UNREVIEWED',
      retrievedAt: new Date(),
      assertedValue: {
        value,
        connectorId: 'manual-entry',
        sourceLabel: 'Pack and registration record',
        batchId: 'manual',
        rowSourceKey: 'manual-entry',
        rights: {
          acquisition: 'Operator evidence',
          cache: 'Workspace',
          redistribution: 'Workspace',
          deletion: 'Audit retention',
        },
        blockingIssues: [],
      },
    })),
  });
  const assertionIds = assertions.map((p) => p.id);
  await expect(api.publishAssertions({ assertionIds })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  await api.recordReviewDecision({
    duplicateKey: 'manual-review',
    action: 'ACCEPT',
    medicineIds: [medicine.id],
    payload: { assertionIds },
  });
  // Accept appends reviewed rows superseding the originals (sev1: never UPDATE).
  const reviewed = assertions.filter((p) => (p as { supersedesId?: string }).supersedesId);
  expect(reviewed).toHaveLength(assertionIds.length);
  expect(reviewed.every((p) => p.status === 'ACCEPTED')).toBe(true);
  await api.publishAssertions({ assertionIds: reviewed.map((p) => p.id) });
  expect(medicine.saleable).toBe(true);
  expect(entries).toHaveLength(6);
  expect(gate(await readiness())?.status).toBe('PASSED');
  const strip = await api.createPackLevel({
    presentationId: 'manual-presentation',
    versionGroupId: 'manual-pack-group',
    level: 'STRIP',
    unitsPerParent: 1,
    effectiveFrom: new Date('2026-01-01'),
  });
  await api.createPackLevel({
    presentationId: 'manual-presentation',
    parentPackLevelId: strip.id,
    versionGroupId: 'manual-unit-group',
    level: 'UNIT',
    unitsPerParent: 10,
    effectiveFrom: new Date('2026-01-01'),
  });
  const workspace = await purchasingWorkspace(
    scoped as unknown as Parameters<typeof purchasingWorkspace>[0],
    { organizationId: 'org-a', actorId: 'admin-a' }
  );
  expect(workspace.medicines[0].packs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ canonicalUnitsPerPack: 10, packLevelId: strip.id }),
    ])
  );
  const stockDb = scoped as unknown as ScopedDb;
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'admin-a' };
  const search = () => searchCounterCatalog(stockDb, scope, { query: 'Paracetamol', at });
  expect((await search()).rows[0]).toMatchObject({ onHandUnits: 0, saleableUnits: [] });
  const pack = workspace.medicines[0].packs[0];
  const receipt = await receiveLot(stockDb, scope, {
    manufacturingBatchId: batch.id,
    packLevelId: pack.packLevelId,
    stockLocationId: location.id,
    unitsPerPack: pack.canonicalUnitsPerPack,
    supplierName: 'Manual supplier',
    supplierInvoiceRef: 'INV-001',
    unitCostMinor: 500,
    printedMrpMinor: 1000,
    receivedExpiresAt: expiresAt,
    receivedExpiryPrecision: 'DAY',
    quantityUnits: 20,
    idempotencyKey: 'manual-stock-in',
    receivedAt: at,
  });
  expect(receipt.movement).toMatchObject({
    kind: 'RECEIPT',
    disposition: 'AVAILABLE',
    quantityUnits: 20,
  });
  const counter = await search();
  expect(counter.rows).toHaveLength(1);
  expect(counter.rows[0]).toMatchObject({
    medicineId: medicine.id,
    recommendedLotId: receipt.lot.id,
    packLevelId: pack.packLevelId,
    onHandUnits: 20,
    blocked: [],
    saleableUnits: expect.arrayContaining([
      expect.objectContaining({
        canonicalUnitsPerSaleUnit: 10,
        wholeUnits: 2,
        unitPriceMinor: 1000,
      }),
    ]),
  });
  expect(db.ingredient.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId_name: { organizationId: 'org-a', name: 'Paracetamol' } },
    })
  );
});

it('rejects caller-supplied organization scope in manual creation', async () => {
  const create = vi.fn();
  await expect(
    caller({
      medicine: { create },
      user: {
        findUnique: vi.fn(async () => ({
          organizationRole: {
            permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        })),
      },
    }).createMedicine({
      productName: 'Other tenant',
      productFamily: 'PHARMACEUTICAL',
      organizationId: 'org-b',
    } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(create).not.toHaveBeenCalled();
});
