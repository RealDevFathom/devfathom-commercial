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

it('creates, reviews, publishes and packs a manual medicine for receiving and onboarding step 8 (in-memory delegates)', async () => {
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
  const packs: object[] = [];
  const entries: object[] = [];
  let published = false;
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
      findMany: vi.fn(async () => assertions),
      updateMany: vi.fn(async ({ data }: { data: { status: string; reviewer: string } }) => {
        assertions = assertions.map((p) => ({ ...p, ...data }));
        return { count: assertions.length };
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
    },
    medicineStrengthComponent: { create: vi.fn(async () => ({})) },
    medicineAlias: { create: vi.fn(async () => ({})) },
    packLevel: {
      create: vi.fn(async ({ data }: { data: object }) => {
        const pack = { id: 'manual-pack', parentPackLevelId: null, effectiveTo: null, ...data };
        packs.push(pack);
        return pack;
      }),
    },
    pharmacyBranch: { findMany: vi.fn(async () => []) },
    pharmacyStockLocation: { findMany: vi.fn(async () => []) },
    pharmacySupplier: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    user: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ organizationRole: null, permissionOverrides: [] })),
    },
    organization: { findUnique: vi.fn(async () => null) },
    pharmacyOnboardingGateState: { findMany: vi.fn(async () => []) },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => null) },
    organizationRole: { count: vi.fn(async () => 0) },
    pharmacyInventoryLot: { count: vi.fn(async () => 0) },
  };
  const scoped = Object.assign(db, {
    $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
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
  await api.publishAssertions({ assertionIds });
  expect(medicine.saleable).toBe(true);
  expect(entries).toHaveLength(6);
  expect(gate(await readiness())?.status).toBe('PASSED');
  await api.createPackLevel({
    presentationId: 'manual-presentation',
    versionGroupId: 'manual-pack-group',
    level: 'STRIP',
    unitsPerParent: 10,
    effectiveFrom: new Date('2026-01-01'),
  });
  const workspace = await purchasingWorkspace(
    scoped as unknown as Parameters<typeof purchasingWorkspace>[0],
    { organizationId: 'org-a', actorId: 'admin-a' }
  );
  expect(workspace.medicines[0].packs).toEqual([
    expect.objectContaining({ canonicalUnitsPerPack: 10, packLevelId: 'manual-pack' }),
  ]);
  expect(db.ingredient.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId_name: { organizationId: 'org-a', name: 'Paracetamol' } },
    })
  );
});

it('rejects caller-supplied organization scope in manual creation', async () => {
  const create = vi.fn();
  await expect(
    caller({ medicine: { create } }).createMedicine({
      productName: 'Other tenant',
      productFamily: 'PHARMACEUTICAL',
      organizationId: 'org-b',
    } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(create).not.toHaveBeenCalled();
});
