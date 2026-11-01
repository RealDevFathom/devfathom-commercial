// @vitest-environment node
/**
 * #970 — a medicine the pharmacy entered by hand and the default catalogue
 * linked to a NARCOTICS item is held from sale until a pharmacist publishes a
 * reviewed `controlled` decision, exactly like a catalogue copy, against
 * PostgreSQL under RLS.
 *
 * The sale is the real counter path (`createSale` + `addSaleLine` against
 * received stock); the review is the real reference workbench path
 * (`recordReviewDecision` + `publishAssertions`). Non-narcotic links and a
 * medicine whose controlled decision was already published are never held.
 *
 * Skipped unless TEST_DATABASE_URL is set (a NOSUPERUSER NOBYPASSRLS role).
 * Every id is unique to the run, as in the other pharmacy sale tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

import { serializeSeedCsv, type DefaultCatalogueSeedRow } from './default-catalogue-seed';

// Exercise the real router, tenant facade and RLS; grant the catalogue-admin
// capability without an unrelated user/role fixture or audit writer.
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));
vi.mock('@/server/audit', () => ({
  isAuditExcludedPath: () => true,
  ipFromHeaders: () => null,
  recordTrpcAudit: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const KEY = `pharmacy-default-hold-test-${suffix}`;
const ORG = `org_medcat_hold_${suffix}`;
const scope = { organizationId: ORG, branchId: `${ORG}_branch`, actorId: 'pharmacist' };

const row = (
  sourceKey: string,
  name: string,
  manufacturer: string,
  strength: string | null,
  dosageForm: string,
  controlledCandidate: boolean
): DefaultCatalogueSeedRow => ({
  sourceKey,
  productName: name,
  brandName: name,
  manufacturer,
  strength,
  dosageForm,
  productFamily: 'PHARMACEUTICAL',
  controlledCandidate,
});

const SEED = serializeSeedCsv([
  // NARCOTICS, matches a saleable hand-entered medicine: linked and held.
  row(
    'catalog-1574',
    'DELTACORTRIL 5MG TAB',
    'GETZ PHARMA PAKISTAN (PVT) LTD',
    '5MG',
    'Tablet',
    true
  ),
  // NARCOTICS, matches a medicine whose controlled decision is already published.
  row('catalog-1334', 'DECADRON 4MG 1ML INJ', 'OBS PHARMA', '4MG', 'Injection', true),
  // Not NARCOTICS, matches a saleable hand-entered medicine: linked, never held.
  row('catalog-27', 'PANADOL 500MG TAB', 'GSK', '500MG', 'Tablet', false),
  // No hand-entered match: copied, the NARCOTICS one flagged.
  row('catalog-2071', 'SOSEGON TAB', 'SEARLE PAKISTAN LTD.', null, 'Tablet', true),
  row('catalog-3', 'BRUFEN 400MG TAB', 'ABBOTT LABORATORIES', '400MG', 'Tablet', false),
]);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  catalogue: typeof import('./default-catalogue');
  sales: typeof import('./sales');
  ledger: typeof import('./stock-ledger');
  router: (typeof import('@/server/routers/pharmacy-medicine'))['pharmacyMedicineRouter'];
};
let deps: Deps;
let versionId = '';
let locationId = '';

const tenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(ORG, work, { timeout: 30_000 });

function api() {
  return deps.router.createCaller({
    db: deps.createTenantDb(ORG, scope.actorId),
    entitlements: { organizationId: ORG, enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: '2099-01-01T00:00:00Z',
      user: { id: scope.actorId, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

/** A saleable medicine the pharmacy entered by hand, with one presentation. */
function handEntered(input: {
  productName: string;
  manufacturer?: string;
  dosageForm: string;
  presentation: string;
}) {
  return tenant((db) =>
    db.medicine.create({
      data: {
        organizationId: ORG,
        productName: input.productName,
        manufacturer: input.manufacturer,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        otc: true,
        presentations: {
          create: {
            organizationId: ORG,
            dosageForm: input.dosageForm,
            presentation: input.presentation,
          },
        },
      },
      include: { presentations: true },
    })
  );
}

/** Receive `units` single units of the medicine into the branch's store. */
function stock(medicineId: string, presentationId: string, units: number) {
  return tenant(async (db) => {
    const pack = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2020-01-01'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ORG,
        medicineId,
        batchNumber: randomUUID(),
        expiresAt: new Date('2031-01-01'),
        expiryPrecision: 'DAY',
      },
    });
    await deps.ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: locationId,
      unitsPerPack: 1,
      supplierName: 'QA',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 10,
      printedMrpMinor: 100,
      receivedExpiresAt: batch.expiresAt,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: units,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2020-01-01'),
    });
    return pack;
  });
}

/** Sell one unit at the counter. */
function sellOne(medicineId: string, presentationId: string, packLevelId: string) {
  return tenant(async (db) => {
    const sale = await deps.sales.createSale(db, scope);
    return deps.sales.addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId,
      presentationId,
      packLevelId,
      saleUnit: 'UNIT',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
  });
}

/**
 * Reference rows for a medicine, as a connector or manual batch would file
 * them (UNREVIEWED), then the pharmacist's ACCEPT review of all of them.
 * Returns the reviewed assertion ids by field.
 */
async function reviewedAssertions(medicineId: string, values: Record<string, string>) {
  const created = await tenant(async (db) => {
    const ids: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      const assertion = await db.medicineProvenance.create({
        data: {
          organizationId: ORG,
          medicineId,
          field,
          source: 'DRAP register (QA)',
          sourceType: 'REGULATOR',
          retrievedAt: new Date('2026-10-01'),
          status: 'UNREVIEWED',
          assertedValue: {
            value,
            connectorId: 'manual-file',
            sourceLabel: 'DRAP register (QA)',
            batchId: `batch-${suffix}`,
            rowSourceKey: `${medicineId}:${field}`,
            rights: {
              acquisition: 'QA fixture',
              cache: 'QA fixture',
              redistribution: 'QA fixture',
              deletion: 'QA fixture',
            },
            blockingIssues: [],
          },
        },
      });
      ids[field] = assertion.id;
    }
    return ids;
  });
  await api().recordReviewDecision({
    duplicateKey: `review:${medicineId}`,
    action: 'ACCEPT',
    medicineIds: [medicineId],
    payload: { assertionIds: Object.values(created) },
  });
  return created;
}

function medicineState(medicineId: string) {
  return tenant((db) =>
    db.medicine.findUniqueOrThrow({
      where: { id: medicineId },
      select: {
        saleable: true,
        controlled: true,
        catalogueProvenance: { select: { controlledCandidate: true, linkedExisting: true } },
      },
    })
  );
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = {
    withTenantDb: scoped.withTenantDb,
    withPlatformDb: scoped.withPlatformDb,
    createTenantDb: scoped.createTenantDb,
    catalogue: await import('./default-catalogue'),
    sales: await import('./sales'),
    ledger: await import('./stock-ledger'),
    router: (await import('@/server/routers/pharmacy-medicine')).pharmacyMedicineRouter,
  };
  await deps.withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: ORG,
        slug: ORG.replace(/_/g, '-'),
        legalName: ORG,
        displayName: ORG,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    })
  );
  locationId = await tenant(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId: ORG,
        code: ORG,
        name: 'QA',
        addressLine: 'QA',
        city: 'QA',
        provinceCode: 'PB',
      },
    });
    return (
      await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG,
          branchId: scope.branchId,
          code: randomUUID(),
          name: 'Stock',
          kind: 'STORE',
        },
      })
    ).id;
  });
  const loaded = await deps.catalogue.loadDefaultCatalogue({ text: SEED, version: 1, key: KEY });
  versionId = loaded.versionId;
});

suite('default catalogue: hand-entered medicine linked to NARCOTICS', { timeout: 90_000 }, () => {
  it('is held from sale until a pharmacist publishes a reviewed controlled decision', async () => {
    // Before the catalogue: three medicines the pharmacy entered by hand, all
    // saleable. The DELTACORTRIL is stocked and sells.
    const deltacortril = await handEntered({
      productName: 'Deltacortril 5mg Tab',
      manufacturer: 'Getz Pharma Pakistan (Pvt) Ltd',
      dosageForm: 'Tablet',
      presentation: 'Deltacortril tablet',
    });
    const decadron = await handEntered({
      productName: 'Decadron 4mg 1ml Inj',
      manufacturer: 'OBS Pharma',
      dosageForm: 'Injection',
      presentation: 'Decadron 1ml ampoule',
    });
    const panadol = await handEntered({
      productName: 'Panadol 500mg Tab',
      dosageForm: 'Tablet',
      presentation: 'Panadol tablet',
    });
    const presentationId = deltacortril.presentations[0]!.id;
    const pack = await stock(deltacortril.id, presentationId, 5);
    await expect(sellOne(deltacortril.id, presentationId, pack.id)).resolves.toMatchObject({
      line: { medicineId: deltacortril.id, quantity: 1 },
    });

    // The DECADRON already had its reviewed controlled decision published.
    const decadronReview = await reviewedAssertions(decadron.id, {
      productName: 'Decadron 4mg 1ml Inj',
      strength: '4 mg',
      dosageForm: 'Injection',
      pack: '1ml ampoule',
      drapRegistrationNumber: '012345',
      controlled: 'false',
    });
    await api().publishAssertions({ assertionIds: Object.values(decadronReview) });
    expect(await medicineState(decadron.id)).toMatchObject({ saleable: true });

    // Dry run: every link listed with its NARCOTICS flag and whether it holds.
    const expectedDuplicates = [
      {
        sourceKey: 'catalog-1334',
        catalogueName: 'DECADRON 4MG 1ML INJ',
        medicineId: decadron.id,
        medicineName: 'Decadron 4mg 1ml Inj',
        action: 'link',
        reason: expect.stringContaining('name "decadron4mg1mlinj"'),
        controlledCandidate: true,
        // Already reviewed: flagged, not held.
        holdFromSale: false,
      },
      {
        sourceKey: 'catalog-1574',
        catalogueName: 'DELTACORTRIL 5MG TAB',
        medicineId: deltacortril.id,
        medicineName: 'Deltacortril 5mg Tab',
        action: 'link',
        reason: expect.stringContaining('name "deltacortril5mgtab"'),
        controlledCandidate: true,
        holdFromSale: true,
      },
      {
        sourceKey: 'catalog-27',
        catalogueName: 'PANADOL 500MG TAB',
        medicineId: panadol.id,
        medicineName: 'Panadol 500mg Tab',
        action: 'link',
        reason: expect.stringContaining('name "panadol500mgtab"'),
        controlledCandidate: false,
        holdFromSale: false,
      },
    ];
    const bySourceKey = <T extends { sourceKey: string }>(rows: readonly T[]) =>
      [...rows].sort((left, right) => (left.sourceKey < right.sourceKey ? -1 : 1));

    const dryRun = await deps.catalogue.backfillDefaultCatalogue({
      apply: false,
      organizationId: ORG,
      catalogueKey: KEY,
    });
    expect(dryRun.organizations[0]).toMatchObject({
      organizationId: ORG,
      wouldCreate: 2,
      possibleExistingMatches: 3,
      // SOSEGON (a copy), DELTACORTRIL and DECADRON (links).
      controlledCandidates: 3,
      wouldHoldFromSale: 1,
    });
    expect(bySourceKey(dryRun.organizations[0]!.likelyDuplicates)).toEqual(expectedDuplicates);
    expect(await medicineState(deltacortril.id)).toMatchObject({ saleable: true });

    // Apply: links all three, flags the NARCOTICS links, holds only DELTACORTRIL.
    const applied = await deps.catalogue.backfillDefaultCatalogue({
      apply: true,
      organizationId: ORG,
      catalogueKey: KEY,
      actor: 'ops@example.com',
    });
    expect(applied.organizations[0]!.applied).toMatchObject({
      created: 2,
      linkedExisting: 3,
      matchedExisting: 3,
      controlledCandidates: 3,
      linkedControlledCandidates: 2,
      heldFromSale: 1,
    });
    expect(bySourceKey(applied.organizations[0]!.applied!.matchedExistingSample)).toEqual(
      expectedDuplicates
    );
    expect(await medicineState(deltacortril.id)).toEqual({
      saleable: false,
      controlled: false,
      catalogueProvenance: { controlledCandidate: true, linkedExisting: true },
    });
    expect(await medicineState(decadron.id)).toMatchObject({
      saleable: true,
      catalogueProvenance: { controlledCandidate: true, linkedExisting: true },
    });
    expect(await medicineState(panadol.id)).toMatchObject({
      saleable: true,
      catalogueProvenance: { controlledCandidate: false, linkedExisting: true },
    });

    const audits = await tenant((db) =>
      db.auditLog.findMany({ where: { action: 'pharmacy.default-catalogue.v1.apply' } })
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toMatchObject({
      created: 2,
      controlledCandidates: 3,
      linkedControlledCandidates: 2,
      heldFromSale: 1,
      linkedExisting: 3,
    });
    expect(
      bySourceKey((audits[0]!.result as unknown as { linked: Array<{ sourceKey: string }> }).linked)
    ).toEqual([
      {
        sourceKey: 'catalog-1334',
        medicineId: decadron.id,
        controlledCandidate: true,
        heldFromSale: false,
      },
      {
        sourceKey: 'catalog-1574',
        medicineId: deltacortril.id,
        controlledCandidate: true,
        heldFromSale: true,
      },
      {
        sourceKey: 'catalog-27',
        medicineId: panadol.id,
        controlledCandidate: false,
        heldFromSale: false,
      },
    ]);

    // Held: the counter refuses it, though the stock is still there; the
    // other two links still sell as before.
    await expect(sellOne(deltacortril.id, presentationId, pack.id)).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });

    // It is in the pharmacist's review queue with the NARCOTICS flag, before
    // any reference row exists for it.
    const queue = await api().referenceCandidates();
    expect(queue.find((candidate) => candidate.id === deltacortril.id)).toMatchObject({
      saleable: false,
      catalogueProvenance: { controlledCandidate: true },
    });
    expect(queue.some((candidate) => [decadron.id, panadol.id].includes(candidate.id))).toBe(false);

    // The review: without a controlled decision the publication is refused
    // and the medicine stays held...
    const review = await reviewedAssertions(deltacortril.id, {
      productName: 'Deltacortril 5mg Tab',
      strength: '5 mg',
      dosageForm: 'Tablet',
      pack: 'Deltacortril tablet',
      drapRegistrationNumber: '067890',
      controlled: 'false',
    });
    const { controlled: controlledDecision, ...withoutDecision } = review;
    await expect(
      api().publishAssertions({ assertionIds: Object.values(withoutDecision) })
    ).rejects.toThrow(/NARCOTICS/);
    expect(await medicineState(deltacortril.id)).toMatchObject({ saleable: false });
    await expect(sellOne(deltacortril.id, presentationId, pack.id)).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });

    // ...with the reviewed decision it is published and released for sale.
    await api().publishAssertions({
      assertionIds: [...Object.values(withoutDecision), controlledDecision!],
    });
    expect(await medicineState(deltacortril.id)).toMatchObject({
      saleable: true,
      controlled: false,
    });
    await expect(sellOne(deltacortril.id, presentationId, pack.id)).resolves.toMatchObject({
      line: { medicineId: deltacortril.id, quantity: 1 },
    });

    // A re-run holds nothing again: the reviewed medicine keeps selling.
    const again = await deps.catalogue.applyDefaultCatalogue(ORG, versionId);
    expect(again).toMatchObject({
      created: 0,
      linkedExisting: 0,
      controlledCandidates: 0,
      heldFromSale: 0,
      alreadyPresent: 5,
    });
    expect(await medicineState(deltacortril.id)).toMatchObject({ saleable: true });
  });
});
