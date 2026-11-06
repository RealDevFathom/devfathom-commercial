// @vitest-environment node
/**
 * #970 — a pharmacist can find and complete what the default catalogue put in
 * the pharmacy, and a reference import never duplicates it, against PostgreSQL
 * under RLS.
 *
 *  - Catalogue copies (and hand-entered medicines held because they were linked
 *    to a NARCOTICS item) are listed in the review workbench's catalogue views,
 *    stay out of every sale path, and are completed through the ordinary
 *    review: draftCatalogueReview → recordReviewDecision (ACCEPT) →
 *    publishAssertions. Publishing reuses the presentation and strength the
 *    medicine already has.
 *  - A reference import row without a target id targets the catalogue copy it
 *    describes (source key, else product name + manufacturer), at import and at
 *    confirmation, and refuses an ambiguous one.
 *  - A provenance row must agree with its catalogue version and item.
 *
 * Skipped unless TEST_DATABASE_URL (a NOSUPERUSER NOBYPASSRLS role) and
 * PHARMACY_TEST_OWNER_DATABASE_URL (the table owner, for cleanup) are set.
 * afterAll deletes every row the run wrote for its own organizations and key.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

import { deleteTestOrganizations } from '../../../tests/delete-test-organizations';

import { serializeSeedCsv, type DefaultCatalogueSeedRow } from './default-catalogue-seed';
import { MANUAL_FILE_RIGHTS } from './reference-connectors';

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
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url && ownerUrl ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const KEY = `pharmacy-default-review-test-${suffix}`;
/** The catalogue is applied after the hand-entered medicine exists. */
const ORG = `org_medcat_review_${suffix}`;
/** A reference row is imported before the catalogue is applied. */
const ORG_LATE = `org_medcat_late_${suffix}`;
/** No catalogue applied: provenance written by hand. */
const ORG_TAMPER = `org_medcat_tamper_${suffix}`;
const ORGS = [ORG, ORG_LATE, ORG_TAMPER];
const ACTOR = 'pharmacist';

const row = (
  sourceKey: string,
  name: string,
  manufacturer: string,
  strength: string | null,
  controlledCandidate = false
): DefaultCatalogueSeedRow => ({
  sourceKey,
  productName: name,
  brandName: name,
  manufacturer,
  strength,
  dosageForm: 'Tablet',
  productFamily: 'PHARMACEUTICAL',
  controlledCandidate,
});

const SEED = serializeSeedCsv([
  row('catalog-27', 'PANADOL 500MG TAB', 'GSK', '500MG'),
  row('catalog-2071', 'SOSEGON TAB', 'SEARLE PAKISTAN LTD.', null, true),
  row('catalog-3', 'BRUFEN 400MG TAB', 'ABBOTT LABORATORIES', '400MG'),
  // Two exports of one product: a name match for it is ambiguous.
  row('catalog-50', 'AMBIG 10MG TAB', 'ACME', '10MG'),
  row('catalog-050', 'AMBIG 10MG TAB', 'ACME', '10MG'),
  row('catalog-77', 'AUGMENTIN 625MG TAB', 'GSK', '625MG'),
  // Matches the hand-entered DELTACORTRIL: linked and held from sale.
  row('catalog-1574', 'DELTACORTRIL 5MG TAB', 'GETZ PHARMA PAKISTAN (PVT) LTD', '5MG', true),
]);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  catalogue: typeof import('./default-catalogue');
  router: (typeof import('@/server/routers/pharmacy-medicine'))['pharmacyMedicineRouter'];
};
let deps: Deps;
let versionId = '';
let deltacortrilId = '';

const inOrg = <T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(organizationId, work, { timeout: 30_000 });

function api(organizationId = ORG) {
  return deps.router.createCaller({
    db: deps.createTenantDb(organizationId, ACTOR),
    entitlements: { organizationId, enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: '2099-01-01T00:00:00Z',
      user: { id: ACTOR, role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const copyOf = (organizationId: string, sourceKey: string) =>
  inOrg(organizationId, async (db) => {
    const provenance = await db.medicineCatalogueProvenance.findFirstOrThrow({
      where: { catalogueKey: KEY, sourceKey },
    });
    return provenance.medicineId;
  });

const medicineState = (organizationId: string, medicineId: string) =>
  inOrg(organizationId, (db) =>
    db.medicine.findUniqueOrThrow({
      where: { id: medicineId },
      select: {
        saleable: true,
        controlled: true,
        presentations: { select: { dosageForm: true, presentation: true } },
        strengths: { select: { value: true, unit: true } },
      },
    })
  );

/** The pharmacist's ACCEPT of every unreviewed assertion, then publication. */
async function acceptAndPublish(organizationId: string, medicineId: string) {
  const assertionIds = await inOrg(organizationId, async (db) =>
    (
      await db.medicineProvenance.findMany({
        where: { medicineId, status: 'UNREVIEWED' },
        select: { id: true },
      })
    ).map(({ id }) => id)
  );
  await api(organizationId).recordReviewDecision({
    duplicateKey: `reference:${medicineId}`,
    action: 'ACCEPT',
    medicineIds: [medicineId],
    payload: { assertionIds },
  });
  return api(organizationId).publishAssertions({ assertionIds });
}

const FILE = 'reference-export.csv';
function referenceRows(batchId: string, rows: Array<[string, Record<string, string>]>) {
  return rows.map(([rowSourceKey, values]) => ({
    batchId,
    rowSourceKey,
    values,
    blockingIssues: [],
    assertions: Object.entries(values).map(([field, value]) => ({
      field: field as 'productName',
      value,
      source: FILE,
      sourceType: 'IMPORT' as const,
      retrievedAt: '2026-10-01T00:00:00.000Z',
      batchId,
      rowSourceKey,
      rights: MANUAL_FILE_RIGHTS,
    })),
  }));
}

const medicineCount = (organizationId: string) =>
  inOrg(organizationId, (db) => db.medicine.count());

beforeAll(async () => {
  if (!url || !ownerUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = {
    withTenantDb: scoped.withTenantDb,
    withPlatformDb: scoped.withPlatformDb,
    createTenantDb: scoped.createTenantDb,
    catalogue: await import('./default-catalogue'),
    router: (await import('@/server/routers/pharmacy-medicine')).pharmacyMedicineRouter,
  };
  await deps.withPlatformDb((db) =>
    db.organization.createMany({
      data: ORGS.map((id) => ({
        id,
        slug: id.replace(/_/g, '-'),
        legalName: id,
        displayName: id,
        vertical: 'PHARMACY' as const,
        status: 'ACTIVE' as const,
      })),
    })
  );
  versionId = (await deps.catalogue.loadDefaultCatalogue({ text: SEED, version: 1, key: KEY }))
    .versionId;

  // ORG entered DELTACORTRIL by hand, saleable, before the catalogue arrived.
  deltacortrilId = await inOrg(ORG, async (db) => {
    const ingredient = await db.ingredient.create({
      data: { organizationId: ORG, name: `Prednisolone ${suffix}` },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: 'Deltacortril 5mg Tab',
        manufacturer: 'Getz Pharma Pakistan (Pvt) Ltd',
        drapRegistrationNumber: '067890',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: {
          create: {
            organizationId: ORG,
            dosageForm: 'Tablet',
            presentation: 'Deltacortril tablet',
          },
        },
        strengths: {
          create: { organizationId: ORG, ingredientId: ingredient.id, value: 5, unit: 'MG' },
        },
      },
    });
    return medicine.id;
  });
  await deps.catalogue.applyDefaultCatalogue(ORG, versionId);
});

afterAll(async () => {
  if (!url || !ownerUrl) return;
  await deleteTestOrganizations(ownerUrl, { organizationIds: ORGS, catalogueKeys: [KEY] });
});

suite('default catalogue: pharmacist review and reference imports', { timeout: 90_000 }, () => {
  it('counts what awaits review and what is held from sale', async () => {
    expect(await api().catalogueReviewSummary()).toEqual({
      awaitingReview: 7,
      copiesAwaitingReview: 6,
      // SOSEGON (a copy) and DELTACORTRIL (a held link).
      controlledAwaitingReview: 2,
      heldFromSale: 1,
    });
    expect(await medicineState(ORG, deltacortrilId)).toMatchObject({ saleable: false });
  });

  it('lists catalogue copies in the workbench, never in a sale path', async () => {
    const panadol = await copyOf(ORG, 'catalog-27');
    await expect(api().get({ id: panadol })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const found = await api().referenceCandidates({ view: 'catalogue', query: 'panadol' });
    expect(found.map(({ id }) => id)).toEqual([panadol]);
    expect(found[0]).toMatchObject({
      saleable: false,
      provenance: [],
      catalogueProvenance: { sourceKey: 'catalog-27', linkedExisting: false },
      catalogueItem: { strength: '500MG', dosageForm: 'Tablet' },
    });
    // By exact source key, too.
    expect(
      (await api().referenceCandidates({ view: 'catalogue', query: 'catalog-27' })).map(
        ({ id }) => id
      )
    ).toEqual([panadol]);

    const controlled = await api().referenceCandidates({ view: 'controlled' });
    expect(controlled.map(({ id }) => id).sort()).toEqual(
      [await copyOf(ORG, 'catalog-2071'), deltacortrilId].sort()
    );
    // The reference queue keeps its meaning: no copy before its review starts,
    // but the held link (as before).
    const reference = await api().referenceCandidates();
    expect(reference.map(({ id }) => id)).toEqual([deltacortrilId]);
  });

  it('completes a copy through draft, the ordinary ACCEPT and publication', async () => {
    const panadol = await copyOf(ORG, 'catalog-27');
    await expect(
      api().draftCatalogueReview({ medicineId: panadol, values: {} })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /DRAP registration/ });

    const draft = await api().draftCatalogueReview({
      medicineId: panadol,
      values: { drapRegistrationNumber: '012345', alias: 'Paracetamol' },
    });
    expect(Object.keys(draft.fields).sort()).toEqual(
      [
        'alias',
        'brandName',
        'dosageForm',
        'drapRegistrationNumber',
        'manufacturer',
        'pack',
        'productName',
        'strength',
      ].sort()
    );
    await expect(
      api().draftCatalogueReview({ medicineId: panadol, values: { drapRegistrationNumber: '1' } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const assertions = await inOrg(ORG, (db) =>
      db.medicineProvenance.findMany({ where: { medicineId: panadol } })
    );
    expect(assertions.find((item) => item.field === 'strength')).toMatchObject({
      status: 'UNREVIEWED',
      sourceType: 'IMPORT',
      source: `platform-default:${KEY}:v1:catalog-27`,
    });
    expect(assertions.find((item) => item.field === 'drapRegistrationNumber')).toMatchObject({
      sourceType: 'USER',
      source: `pharmacist:${ACTOR}`,
    });
    // Now it is in the ordinary reference queue too, still unsaleable.
    expect((await api().referenceCandidates()).some(({ id }) => id === panadol)).toBe(true);
    expect(await medicineState(ORG, panadol)).toMatchObject({ saleable: false });

    await acceptAndPublish(ORG, panadol);
    const published = await medicineState(ORG, panadol);
    expect(published).toMatchObject({ saleable: true, controlled: false });
    // The presentation the catalogue created is completed, not duplicated.
    expect(published.presentations).toEqual([
      { dosageForm: 'Tablet', presentation: '500MG Tablet' },
    ]);
    expect(published.strengths.map(({ value, unit }) => [String(value), unit])).toEqual([
      ['500', 'MG'],
    ]);
    await expect(api().get({ id: panadol })).resolves.toMatchObject({ id: panadol });
    expect(await api().catalogueReviewSummary()).toMatchObject({ awaitingReview: 6 });
  });

  it('holds a NARCOTICS copy until the draft carries a controlled decision', async () => {
    const sosegon = await copyOf(ORG, 'catalog-2071');
    const values = { strength: '25 mg', pack: '10 tablets', drapRegistrationNumber: '054321' };
    await expect(
      api().draftCatalogueReview({ medicineId: sosegon, values })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /NARCOTICS/ });
    await api().draftCatalogueReview({
      medicineId: sosegon,
      values: { ...values, controlled: 'true' },
    });
    await acceptAndPublish(ORG, sosegon);
    expect(await medicineState(ORG, sosegon)).toMatchObject({ saleable: true, controlled: true });
  });

  it('releases a held hand-entered medicine from its own record, nothing twice', async () => {
    const before = await medicineState(ORG, deltacortrilId);
    await api().draftCatalogueReview({
      medicineId: deltacortrilId,
      values: { controlled: 'false' },
    });
    const drafted = await inOrg(ORG, (db) =>
      db.medicineProvenance.findMany({
        where: { medicineId: deltacortrilId, status: 'UNREVIEWED' },
      })
    );
    expect(
      Object.fromEntries(
        drafted.map((item) => [item.field, (item.assertedValue as { value: string }).value])
      )
    ).toEqual({
      productName: 'Deltacortril 5mg Tab',
      manufacturer: 'Getz Pharma Pakistan (Pvt) Ltd',
      drapRegistrationNumber: '067890',
      strength: '5 MG',
      dosageForm: 'Tablet',
      pack: 'Deltacortril tablet',
      controlled: 'false',
    });

    await acceptAndPublish(ORG, deltacortrilId);
    const after = await medicineState(ORG, deltacortrilId);
    expect(after).toMatchObject({ saleable: true, controlled: false });
    expect(after.presentations).toEqual(before.presentations);
    expect(after.strengths).toHaveLength(before.strengths.length);
    expect(await api().catalogueReviewSummary()).toMatchObject({
      heldFromSale: 0,
      controlledAwaitingReview: 0,
    });
  });

  it('imports reference rows onto the catalogue copies they describe, no duplicate', async () => {
    const medicinesBefore = await medicineCount(ORG);
    const batchId = `batch-${suffix}`;
    const run = await api().runReferenceConnectorNow({
      connectorId: 'manual-file',
      batchId,
      fileName: FILE,
      rows: referenceRows(batchId, [
        // By source key.
        [
          'catalog-3',
          {
            productName: 'BRUFEN 400MG TAB',
            drapRegistrationNumber: '0999',
            strength: '400 mg',
            dosageForm: 'Tablet',
            pack: '400MG Tablet',
          },
        ],
        // By product name and manufacturer, case-insensitively.
        [
          'row-11',
          {
            productName: 'augmentin 625mg tab',
            manufacturer: 'gsk',
            strength: '625 mg',
            dosageForm: 'Tablet',
            pack: '2 x 6',
          },
        ],
        // Two copies share the name: refused, not guessed.
        ['row-12', { productName: 'Ambig 10mg Tab', manufacturer: 'Acme', strength: '10 mg' }],
        // Not in the catalogue: a new-medicine proposal, as before.
        ['row-13', { productName: 'Brand New Medicine', strength: '1 mg' }],
      ]),
    });
    expect(run).toMatchObject({ rowsRejected: 1, proposalRows: 3 });
    expect(run.rejectionReasons).toEqual([
      { rowSourceKey: 'row-12', reasons: ['AMBIGUOUS_CATALOGUE_MATCH'] },
    ]);
    const proposals = await inOrg(ORG, (db) =>
      db.pharmacyReferenceConnectorProposal.findMany({ where: { runId: run.id } })
    );
    const brufen = await copyOf(ORG, 'catalog-3');
    const augmentin = await copyOf(ORG, 'catalog-77');
    expect(
      Object.fromEntries(proposals.map((item) => [item.rowSourceKey, item.targetMedicineId]))
    ).toEqual({ 'catalog-3': brufen, 'row-11': augmentin, 'row-13': null });

    // Confirming and publishing completes the copy; no medicine is created.
    const brufenProposal = proposals.find((item) => item.rowSourceKey === 'catalog-3')!;
    await api().decideReferenceConnectorProposal({
      proposalId: brufenProposal.id,
      decision: 'CONFIRM',
    });
    const accepted = await inOrg(ORG, async (db) =>
      (
        await db.medicineProvenance.findMany({
          where: { medicineId: brufen, status: 'ACCEPTED' },
          select: { id: true },
        })
      ).map(({ id }) => id)
    );
    await api().publishAssertions({ assertionIds: accepted });
    expect(await medicineState(ORG, brufen)).toMatchObject({
      saleable: true,
      presentations: [{ dosageForm: 'Tablet', presentation: '400MG Tablet' }],
    });
    expect(await medicineCount(ORG)).toBe(medicinesBefore);
  });

  it('confirms a row imported before the catalogue onto the copy applied since', async () => {
    const batchId = `batch-late-${suffix}`;
    const run = await api(ORG_LATE).runReferenceConnectorNow({
      connectorId: 'manual-file',
      batchId,
      fileName: FILE,
      rows: referenceRows(batchId, [
        ['catalog-27', { productName: 'PANADOL 500MG TAB', strength: '500 mg' }],
      ]),
    });
    const proposal = await inOrg(ORG_LATE, (db) =>
      db.pharmacyReferenceConnectorProposal.findFirstOrThrow({ where: { runId: run.id } })
    );
    expect(proposal.targetMedicineId).toBeNull();

    await deps.catalogue.applyDefaultCatalogue(ORG_LATE, versionId);
    const copies = await medicineCount(ORG_LATE);
    const confirmed = await api(ORG_LATE).decideReferenceConnectorProposal({
      proposalId: proposal.id,
      decision: 'CONFIRM',
    });
    expect(confirmed.targetMedicineId).toBe(await copyOf(ORG_LATE, 'catalog-27'));
    expect(await medicineCount(ORG_LATE)).toBe(copies);
  });

  it('refuses provenance that disagrees with its catalogue version or item', async () => {
    const medicineId = await inOrg(ORG_TAMPER, async (db) =>
      (
        await db.medicine.create({
          data: {
            organizationId: ORG_TAMPER,
            productName: 'Hand entered',
            productFamily: 'PHARMACEUTICAL',
          },
        })
      ).id
    );
    const write = (data: {
      sourceKey: string;
      controlledCandidate: boolean;
      catalogueKey?: string;
      catalogueVersion?: number;
    }) =>
      inOrg(ORG_TAMPER, (db) =>
        db.medicineCatalogueProvenance.create({
          data: {
            organizationId: ORG_TAMPER,
            medicineId,
            catalogueKey: data.catalogueKey ?? KEY,
            catalogueVersion: data.catalogueVersion ?? 1,
            catalogueVersionId: versionId,
            sourceKey: data.sourceKey,
            contentDigest: 'x',
            controlledCandidate: data.controlledCandidate,
            linkedExisting: true,
          },
        })
      );

    await expect(write({ sourceKey: 'catalog-2071', controlledCandidate: false })).rejects.toThrow(
      /NARCOTICS review flag/
    );
    await expect(
      write({ sourceKey: 'catalog-27', controlledCandidate: false, catalogueVersion: 2 })
    ).rejects.toThrow(/key and version must match/);
    await expect(
      write({ sourceKey: 'catalog-27', controlledCandidate: false, catalogueKey: `${KEY}-other` })
    ).rejects.toThrow(/key and version must match/);
    await expect(
      write({ sourceKey: 'catalog-missing', controlledCandidate: false })
    ).rejects.toThrow(/does not hold/);
    // Agreeing with the item, or stricter than it, is accepted.
    await expect(
      write({ sourceKey: 'catalog-2071', controlledCandidate: true })
    ).resolves.toMatchObject({ controlledCandidate: true });
  });
});
