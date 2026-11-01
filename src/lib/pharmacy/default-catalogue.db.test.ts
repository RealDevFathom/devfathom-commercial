/**
 * Platform default medicine catalogue — against migrated PostgreSQL with
 * FORCED row-level security, as the NOSUPERUSER/NOBYPASSRLS runtime role.
 *
 * Uses the committed 50-row fixture under a catalogue key unique to this run,
 * so nothing here depends on (or disturbs) a real catalogue in the database,
 * and every backfill is pinned to this suite's own organizations.
 *
 * Skipped (never silently passed) when the database URLs are absent.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { parseSeedCsv, serializeSeedCsv } from './default-catalogue-seed';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
if (RUNTIME_DATABASE_URL) process.env.DATABASE_URL = RUNTIME_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const KEY = `pharmacy-default-test-${suffix}`;
const ORG_A = `org_medcat_a_${suffix}`;
const ORG_B = `org_medcat_b_${suffix}`;
const ORG_AGENCY = `org_medcat_agency_${suffix}`;
const ORG_C = `org_medcat_c_${suffix}`;
const ORG_D = `org_medcat_d_${suffix}`;
const ORGS = [ORG_A, ORG_B, ORG_AGENCY, ORG_C, ORG_D];
// A second catalogue for the leading-zero source keys, so the 50-row fixture
// counts above stay as they are.
const ZERO_KEY = `${KEY}-zeros`;
const KEYS = [KEY, ZERO_KEY];

const FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/pharmacy-default-catalogue-50.csv'),
  'utf8'
);
const FIXTURE_ROWS = parseSeedCsv(FIXTURE);
const FIXTURE_CONTROLLED = FIXTURE_ROWS.filter((row) => row.controlledCandidate).length;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  catalogue: typeof import('./default-catalogue');
};
let deps: Deps;
let versionOneId = '';

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

async function ownerQuery(sql: string, params: unknown[] = []) {
  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    return await owner.query(sql, params);
  } finally {
    await owner.end();
  }
}

async function tenantCounts(organizationId: string) {
  return inOrg(organizationId, async (db) => ({
    medicines: await db.medicine.count(),
    provenance: await db.medicineCatalogueProvenance.count(),
    controlledCandidates: await db.medicineCatalogueProvenance.count({
      where: { controlledCandidate: true },
    }),
    saleable: await db.medicine.count({ where: { saleable: true } }),
    controlled: await db.medicine.count({ where: { controlled: true } }),
    packLevels: await db.packLevel.count(),
    batches: await db.pharmacyManufacturingBatch.count(),
    lots: await db.pharmacyInventoryLot.count(),
  }));
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(RUNTIME_DATABASE_URL).not.toBe(OWNER_DATABASE_URL);
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = {
    withTenantDb: scoped.withTenantDb,
    withPlatformDb: scoped.withPlatformDb,
    catalogue: await import('./default-catalogue'),
  };

  const runtime = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await runtime.connect();
  try {
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  } finally {
    await runtime.end();
  }

  await ownerQuery(
    `INSERT INTO organizations
      (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Medcat A', 'Medcat A', 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now()),
            ($3, $4, 'Medcat B', 'Medcat B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
            ($5, $6, 'Medcat Agency', 'Medcat Agency', 'AGENCY', 'ACTIVE', 'SHARED', now(), now()),
            ($7, $8, 'Medcat C', 'Medcat C', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
            ($9, $10, 'Medcat D', 'Medcat D', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
    [
      ORG_A,
      `medcat-a-${suffix}`,
      ORG_B,
      `medcat-b-${suffix}`,
      ORG_AGENCY,
      `medcat-agency-${suffix}`,
      ORG_C,
      `medcat-c-${suffix}`,
      ORG_D,
      `medcat-d-${suffix}`,
    ]
  );
});

afterAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  await ownerQuery(
    'DELETE FROM pharmacy_medicine_catalogue_provenance WHERE "organizationId" = ANY($1)',
    [ORGS]
  );
  await ownerQuery('DELETE FROM audit_logs WHERE "organizationId" = ANY($1)', [ORGS]);
  await ownerQuery('DELETE FROM pharmacy_presentations WHERE "organizationId" = ANY($1)', [ORGS]);
  await ownerQuery(
    'DELETE FROM pharmacy_medicine_strength_components WHERE "organizationId" = ANY($1)',
    [ORGS]
  );
  await ownerQuery('DELETE FROM pharmacy_ingredients WHERE "organizationId" = ANY($1)', [ORGS]);
  await ownerQuery('DELETE FROM pharmacy_medicines WHERE "organizationId" = ANY($1)', [ORGS]);
  await ownerQuery(
    `DELETE FROM platform_medicine_catalogue_items WHERE "versionId" IN
       (SELECT id FROM platform_medicine_catalogue_versions WHERE key = ANY($1))`,
    [KEYS]
  );
  await ownerQuery('DELETE FROM platform_medicine_catalogue_versions WHERE key = ANY($1)', [KEYS]);
  await ownerQuery('DELETE FROM platform_jobs WHERE "organizationId" = ANY($1)', [ORGS]);
  await ownerQuery('DELETE FROM organizations WHERE id = ANY($1)', [ORGS]);
});

describeIfDatabase('platform default medicine catalogue', { timeout: 60_000 }, () => {
  it('loads the seed once; a second run with the same digest is a no-op', async () => {
    const first = await deps.catalogue.loadDefaultCatalogue({
      text: FIXTURE,
      version: 1,
      key: KEY,
      batchSize: 20,
    });
    expect(first).toMatchObject({ status: 'created', rowCount: 50, inserted: 50 });
    versionOneId = first.versionId;

    const second = await deps.catalogue.loadDefaultCatalogue({
      text: FIXTURE,
      version: 1,
      key: KEY,
    });
    expect(second).toMatchObject({ status: 'unchanged', versionId: versionOneId, inserted: 0 });

    const stored = await deps.withPlatformDb(async (db) => ({
      items: await db.platformMedicineCatalogueItem.count({ where: { versionId: versionOneId } }),
      versions: await db.platformMedicineCatalogueVersion.findMany({ where: { key: KEY } }),
    }));
    expect(stored.items).toBe(50);
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0]!.publishedAt).not.toBeNull();

    // A published version never changes: new content needs a new version.
    const edited = FIXTURE.replace('DISPRIN 300MG TAB,', 'DISPRIN 325MG TAB,');
    await expect(
      deps.catalogue.loadDefaultCatalogue({ text: edited, version: 1, key: KEY })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('keeps the shared catalogue read-only to tenants', async () => {
    await expect(
      inOrg(ORG_A, (db) =>
        db.platformMedicineCatalogueItem.create({
          data: {
            versionId: versionOneId,
            sourceKey: 'catalog-tenant-write',
            productName: 'Tenant write',
            productFamily: 'PHARMACEUTICAL',
          },
        })
      )
    ).rejects.toThrow();
    // ...but readable from a tenant scope, which is how it is materialised.
    const visible = await inOrg(ORG_A, (db) =>
      db.platformMedicineCatalogueItem.count({ where: { versionId: versionOneId } })
    );
    expect(visible).toBe(50);
  });

  it('gives a new pharmacy every medicine with zero stock, held back from sale', async () => {
    const result = await deps.catalogue.runDefaultCatalogueJob({
      organizationId: ORG_A,
      payload: { catalogueKey: KEY, reason: 'provisioning' },
    });
    expect(result).toMatchObject({
      organizationId: ORG_A,
      versionId: versionOneId,
      created: 50,
      alreadyPresent: 0,
      controlledCandidates: FIXTURE_CONTROLLED,
    });

    expect(await tenantCounts(ORG_A)).toEqual({
      medicines: 50,
      provenance: 50,
      controlledCandidates: FIXTURE_CONTROLLED,
      saleable: 0,
      // NARCOTICS is a review flag, never an invented controlled classification.
      controlled: 0,
      packLevels: 0,
      batches: 0,
      lots: 0,
    });

    const narcotic = await inOrg(ORG_A, (db) =>
      db.medicineCatalogueProvenance.findFirst({
        where: { sourceKey: 'catalog-916' },
        include: { medicine: { include: { presentations: true } } },
      })
    );
    expect(narcotic).toMatchObject({
      source: 'platform-default',
      catalogueKey: KEY,
      catalogueVersion: 1,
      controlledCandidate: true,
      medicine: {
        productName: 'ALP 0.5MG TAB',
        saleable: false,
        controlled: false,
        presentations: [{ dosageForm: 'Tablet', presentation: '0.5MG Tablet' }],
      },
    });
  });

  it('materialises nothing into a non-pharmacy organization', async () => {
    await expect(
      deps.catalogue.runDefaultCatalogueJob({
        organizationId: ORG_AGENCY,
        payload: { catalogueKey: KEY },
      })
    ).rejects.toMatchObject({ code: 'NOT_A_PHARMACY' });
    expect((await tenantCounts(ORG_AGENCY)).medicines).toBe(0);
  });

  it('reports a missing catalogue as a skipped job, not a failure', async () => {
    await expect(
      deps.catalogue.runDefaultCatalogueJob({
        organizationId: ORG_B,
        payload: { catalogueKey: `${KEY}-absent` },
      })
    ).resolves.toEqual({
      status: 'NO_PUBLISHED_VERSION',
      organizationId: ORG_B,
      catalogueKey: `${KEY}-absent`,
    });
    expect((await tenantCounts(ORG_B)).medicines).toBe(0);
  });

  it('backfills in batches, dry-run first, and never duplicates on a re-run', async () => {
    const dryRun = await deps.catalogue.backfillDefaultCatalogue({
      apply: false,
      organizationId: ORG_B,
      catalogueKey: KEY,
    });
    expect(dryRun).toMatchObject({ mode: 'dry-run', versionId: versionOneId });
    expect(dryRun.organizations).toEqual([
      expect.objectContaining({ organizationId: ORG_B, heldBefore: 0, missingBefore: 50 }),
    ]);
    expect(dryRun.organizations[0]!.applied).toBeUndefined();
    expect((await tenantCounts(ORG_B)).medicines).toBe(0);

    const first = await deps.catalogue.backfillDefaultCatalogue({
      apply: true,
      organizationId: ORG_B,
      catalogueKey: KEY,
      batchSize: 20,
    });
    expect(first.organizations[0]!.applied).toMatchObject({ created: 50, batches: 3 });

    const second = await deps.catalogue.backfillDefaultCatalogue({
      apply: true,
      organizationId: ORG_B,
      catalogueKey: KEY,
      batchSize: 20,
    });
    expect(second.organizations[0]).toMatchObject({ heldBefore: 50, missingBefore: 0 });
    expect(second.organizations[0]!.applied).toMatchObject({ created: 0, alreadyPresent: 50 });
    expect((await tenantCounts(ORG_B)).medicines).toBe(50);
    expect((await tenantCounts(ORG_B)).provenance).toBe(50);
  });

  it('keeps each tenant to its own copies', async () => {
    const bIds = await inOrg(ORG_B, (db) =>
      db.medicine.findMany({ select: { id: true }, take: 5 })
    );
    const seenFromA = await inOrg(ORG_A, async (db) => ({
      medicines: await db.medicine.count({ where: { id: { in: bIds.map(({ id }) => id) } } }),
      bProvenance: await db.medicineCatalogueProvenance.count({
        where: { organizationId: ORG_B },
      }),
    }));
    expect(seenFromA).toEqual({ medicines: 0, bProvenance: 0 });

    // RLS refuses a provenance row written into another tenant.
    await expect(
      inOrg(ORG_A, (db) =>
        db.medicineCatalogueProvenance.create({
          data: {
            organizationId: ORG_B,
            medicineId: bIds[0]!.id,
            catalogueKey: KEY,
            catalogueVersion: 1,
            catalogueVersionId: versionOneId,
            sourceKey: 'catalog-cross-tenant',
            contentDigest: 'x',
          },
        })
      )
    ).rejects.toThrow();
  });

  it('never overwrites a tenant edit; a new version only adds and reports diffs', async () => {
    const edited = await inOrg(ORG_A, async (db) => {
      const provenance = await db.medicineCatalogueProvenance.findFirstOrThrow({
        where: { sourceKey: 'catalog-20' },
      });
      return db.medicine.update({
        where: { id: provenance.medicineId },
        data: { productName: 'Bremax 1 mg (pharmacist corrected)', saleable: false },
      });
    });

    // Version 2: the platform changed catalog-20 and catalog-21, and added one item.
    const rows = FIXTURE_ROWS.map((row) =>
      row.sourceKey === 'catalog-20' || row.sourceKey === 'catalog-21'
        ? { ...row, manufacturer: 'ABBOTT LABORATORIES (PAKISTAN) LTD' }
        : row
    );
    rows.push({
      sourceKey: 'catalog-999999',
      productName: 'NEW ITEM 10MG TAB',
      brandName: 'NEW ITEM 10MG TAB',
      manufacturer: null,
      strength: '10MG',
      dosageForm: 'Tablet',
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: false,
    });
    const v2 = await deps.catalogue.loadDefaultCatalogue({
      text: serializeSeedCsv(rows),
      version: 2,
      key: KEY,
    });
    expect(v2).toMatchObject({ status: 'created', rowCount: 51 });

    const applied = await deps.catalogue.applyDefaultCatalogue(ORG_A, v2.versionId);
    expect(applied).toMatchObject({
      version: 2,
      created: 1,
      alreadyPresent: 50,
      upstreamChanged: 2,
    });
    expect([...applied.upstreamChangedSample].sort()).toEqual(['catalog-20', 'catalog-21']);

    const after = await inOrg(ORG_A, async (db) => ({
      edited: await db.medicine.findUniqueOrThrow({ where: { id: edited.id } }),
      untouched: await db.medicineCatalogueProvenance.findFirstOrThrow({
        where: { sourceKey: 'catalog-21' },
        include: { medicine: true },
      }),
      added: await db.medicineCatalogueProvenance.findFirstOrThrow({
        where: { sourceKey: 'catalog-999999' },
      }),
      medicines: await db.medicine.count(),
    }));
    expect(after.edited.productName).toBe('Bremax 1 mg (pharmacist corrected)');
    expect(after.untouched.catalogueVersion).toBe(1);
    expect(after.untouched.medicine.manufacturer).toBe('ABBOTT LABORATORIES');
    expect(after.added.catalogueVersion).toBe(2);
    expect(after.medicines).toBe(51);

    // And again: nothing new, the same diffs, the edit still intact.
    const again = await deps.catalogue.applyDefaultCatalogue(ORG_A, v2.versionId);
    expect(again).toMatchObject({ created: 0, alreadyPresent: 51, upstreamChanged: 2 });
  });

  it('lets a tenant read but never rewrite or drop its review flags', async () => {
    const tampered = await inOrg(ORG_A, async (db) => ({
      updated: (
        await db.medicineCatalogueProvenance.updateMany({
          where: { controlledCandidate: true },
          data: { controlledCandidate: false },
        })
      ).count,
      deleted: (await db.medicineCatalogueProvenance.deleteMany({})).count,
    }));
    expect(tampered).toEqual({ updated: 0, deleted: 0 });
    expect((await tenantCounts(ORG_A)).controlledCandidates).toBe(FIXTURE_CONTROLLED);
  });

  it('lists hand-entered duplicates in the dry run, links them on apply, and stays stable', async () => {
    // Medicines the pharmacy entered by hand (manual entry, the importer
    // wizard, a reference connector) before the catalogue arrived. None has
    // catalogue provenance.
    const manual = await inOrg(ORG_C, async (db) => {
      const create = async (
        data: { productName: string; brandName?: string; manufacturer?: string },
        dosageForm: string,
        presentation: string
      ) => {
        const medicine = await db.medicine.create({
          data: { organizationId: ORG_C, productFamily: 'PHARMACEUTICAL', ...data },
        });
        await db.presentation.create({
          data: { organizationId: ORG_C, medicineId: medicine.id, dosageForm, presentation },
        });
        return medicine;
      };
      const ingredient = await db.ingredient.create({
        data: { organizationId: ORG_C, name: `Acetylsalicylic acid ${suffix}` },
      });
      // Same name and brand in different case and spacing, structured 300 mg,
      // same dosage form, the same manufacturer written differently.
      const disprin = await create(
        {
          productName: 'Disprin 300mg Tab',
          brandName: 'DISPRIN  300MG TAB',
          manufacturer: 'Reckit & Benckiser (BMC)',
        },
        'Tablet',
        '300mg tablet'
      );
      await db.medicineStrengthComponent.create({
        data: {
          organizationId: ORG_C,
          medicineId: disprin.id,
          ingredientId: ingredient.id,
          value: '300',
          unit: 'mg',
        },
      });
      // Its product name is catalog-20 and its brand is catalog-21: both match,
      // but one medicine can carry only one catalogue link.
      const bremax = await create(
        { productName: 'Bremax 1mg Tab', brandName: 'BREMAX 2MG TAB' },
        'Tablet',
        'Bremax tablet'
      );
      // Same name, strength and form as catalog-26 but another manufacturer:
      // not a duplicate, so the catalogue copy is still created.
      const cecon = await create(
        { productName: 'CECON 500MG TAB', manufacturer: 'GlaxoSmithKline' },
        'Tablet',
        '500mg tablet'
      );
      return {
        disprin,
        bremax,
        cecon,
        before: await db.medicine.findMany({
          where: { id: { in: [disprin.id, bremax.id, cecon.id] } },
          orderBy: { id: 'asc' },
        }),
      };
    });

    const expectedDuplicates = [
      {
        sourceKey: 'catalog-00',
        catalogueName: 'DISPRIN 300MG TAB',
        medicineId: manual.disprin.id,
        medicineName: 'Disprin 300mg Tab',
        action: 'link',
        reason:
          'name "disprin300mgtab" (catalogue productName = medicine productName); ' +
          'strength 300mg; dosage form tablet; manufacturer reckitbenckiserbmc',
        controlledCandidate: false,
        holdFromSale: false,
      },
      {
        sourceKey: 'catalog-20',
        catalogueName: 'BREMAX 1MG TAB',
        medicineId: manual.bremax.id,
        medicineName: 'Bremax 1mg Tab',
        action: 'link',
        reason: expect.stringContaining(
          'name "bremax1mgtab" (catalogue productName = medicine productName); ' +
            "strength 1mg (in the medicine's name"
        ),
        controlledCandidate: false,
        holdFromSale: false,
      },
      {
        sourceKey: 'catalog-21',
        catalogueName: 'BREMAX 2MG TAB',
        medicineId: manual.bremax.id,
        medicineName: 'Bremax 1mg Tab',
        action: 'skip',
        linkedSourceKey: 'catalog-20',
        reason: expect.stringContaining(
          'name "bremax2mgtab" (catalogue productName = medicine brandName)'
        ),
        controlledCandidate: false,
        holdFromSale: false,
      },
    ];

    // Dry run: lists every likely duplicate with the medicine and the reason,
    // and writes nothing.
    const dryRun = await deps.catalogue.backfillDefaultCatalogue({
      apply: false,
      organizationId: ORG_C,
      catalogueKey: KEY,
      version: 1,
      batchSize: 20,
    });
    expect(dryRun.organizations[0]).toMatchObject({
      heldBefore: 0,
      wouldCreate: 47,
      possibleExistingMatches: 3,
      // None of the three matched items is NARCOTICS: every flag is on a copy.
      controlledCandidates: FIXTURE_CONTROLLED,
      wouldHoldFromSale: 0,
    });
    expect(dryRun.organizations[0]!.likelyDuplicates).toEqual(expectedDuplicates);
    expect(await tenantCounts(ORG_C)).toMatchObject({ medicines: 3, provenance: 0 });

    // Apply: links instead of duplicating, and never touches the tenant's fields.
    const applied = await deps.catalogue.backfillDefaultCatalogue({
      apply: true,
      organizationId: ORG_C,
      catalogueKey: KEY,
      version: 1,
      batchSize: 20,
      actor: 'ops@example.com',
    });
    expect(applied.organizations[0]!.likelyDuplicates).toEqual(expectedDuplicates);
    expect(applied.organizations[0]!.applied).toMatchObject({
      created: 47,
      alreadyPresent: 0,
      linkedExisting: 2,
      matchedExisting: 3,
      controlledCandidates: FIXTURE_CONTROLLED,
      linkedControlledCandidates: 0,
      heldFromSale: 0,
    });
    expect(applied.organizations[0]!.applied!.matchedExistingSample).toEqual(expectedDuplicates);

    const snapshot = () =>
      inOrg(ORG_C, async (db) => ({
        counts: await tenantCounts(ORG_C),
        manual: await db.medicine.findMany({
          where: { id: { in: [manual.disprin.id, manual.bremax.id, manual.cecon.id] } },
          orderBy: { id: 'asc' },
        }),
        manualPresentations: await db.presentation.count({
          where: { medicineId: { in: [manual.disprin.id, manual.bremax.id, manual.cecon.id] } },
        }),
        links: await db.medicineCatalogueProvenance.findMany({
          where: { linkedExisting: true },
          orderBy: { sourceKey: 'asc' },
        }),
        catalog21: await db.medicineCatalogueProvenance.count({
          where: { sourceKey: 'catalog-21' },
        }),
        copies: {
          disprin: await db.medicine.count({
            where: { productName: { equals: 'DISPRIN 300MG TAB', mode: 'insensitive' } },
          }),
          bremax1: await db.medicine.count({
            where: { productName: { equals: 'BREMAX 1MG TAB', mode: 'insensitive' } },
          }),
          bremax2: await db.medicine.count({
            where: { productName: { equals: 'BREMAX 2MG TAB', mode: 'insensitive' } },
          }),
          cecon: await db.medicine.count({ where: { productName: 'CECON 500MG TAB' } }),
        },
        audits: await db.auditLog.findMany({
          where: { action: 'pharmacy.default-catalogue.v1.apply' },
        }),
      }));
    const after = await snapshot();
    expect(after.counts).toMatchObject({ medicines: 50, provenance: 49 });
    // Every field of the tenant's own medicines, updatedAt included, is unchanged.
    expect(after.manual).toEqual(manual.before);
    expect(after.manualPresentations).toBe(3);
    expect(after.links).toEqual([
      expect.objectContaining({
        medicineId: manual.disprin.id,
        source: 'platform-default',
        catalogueKey: KEY,
        catalogueVersion: 1,
        catalogueVersionId: versionOneId,
        sourceKey: 'catalog-00',
        linkedExisting: true,
        controlledCandidate: false,
      }),
      expect.objectContaining({
        medicineId: manual.bremax.id,
        source: 'platform-default',
        catalogueVersion: 1,
        sourceKey: 'catalog-20',
        linkedExisting: true,
        controlledCandidate: false,
      }),
    ]);
    expect(after.catalog21).toBe(0);
    // No copies beside the linked medicines; the other manufacturer's CECON is
    // not a duplicate, so its catalogue copy exists beside the tenant's.
    expect(after.copies).toEqual({ disprin: 1, bremax1: 1, bremax2: 0, cecon: 2 });

    expect(after.audits).toHaveLength(3);
    const total = (
      key: 'created' | 'linkedExisting' | 'controlledCandidates' | 'heldFromSale'
    ) =>
      after.audits.reduce(
        (sum, row) => sum + Number((row.result as Record<string, number>)[key]),
        0
      );
    expect(total('created')).toBe(47);
    expect(total('linkedExisting')).toBe(2);
    expect(total('controlledCandidates')).toBe(FIXTURE_CONTROLLED);
    expect(total('heldFromSale')).toBe(0);
    for (const row of after.audits) {
      expect(row).toMatchObject({
        actorType: 'SYSTEM',
        actorName: 'ops@example.com',
        metadata: expect.objectContaining({ trigger: 'backfill', actorName: 'ops@example.com' }),
      });
    }

    // Re-runs, by apply and by dry run: nothing created, nothing re-linked,
    // the same skipped duplicate reported, everything else unchanged.
    for (let run = 0; run < 2; run += 1) {
      const again = await deps.catalogue.applyDefaultCatalogue(ORG_C, versionOneId, {
        batchSize: 20,
      });
      expect(again).toMatchObject({
        created: 0,
        linkedExisting: 0,
        alreadyPresent: 49,
        matchedExisting: 1,
        controlledCandidates: 0,
        heldFromSale: 0,
      });
      expect(again.matchedExistingSample).toEqual([expectedDuplicates[2]]);
    }
    const reDryRun = await deps.catalogue.backfillDefaultCatalogue({
      apply: false,
      organizationId: ORG_C,
      catalogueKey: KEY,
      version: 1,
    });
    expect(reDryRun.organizations[0]).toMatchObject({
      heldBefore: 49,
      wouldCreate: 0,
      possibleExistingMatches: 1,
      controlledCandidates: 0,
      wouldHoldFromSale: 0,
      likelyDuplicates: [expectedDuplicates[2]],
    });
    expect(await snapshot()).toEqual(after);
  });

  it('keeps leading-zero source keys distinct from load to tenant', async () => {
    const zeros = [
      ['catalog-0', 'LITEPLUS TAB', 'WILSHIRE LABORATORIES(PVT)LTD'],
      ['catalog-00', 'DISPRIN 300MG TAB', 'RECKIT&BENCKISER(BMC )'],
      ['catalog-000', 'DISPRIN 300MG TAB (100S)', 'RECKIT&BENCKISER(BMC )'],
      ['catalog-0000', 'LABELLO LIP BALM ROSE SOFT', 'MISC'],
      ['catalog-000000', 'HIN NEU D', 'NABIQASIM'],
      ['catalog-11', 'BECEFOL TAB (25S)', 'ABBOTT LABORATORIES'],
      ['catalog-000011', 'A/F SULTAN AL RAHEEB 300ML', 'CONSUMER'],
      ['catalog-33324', 'ALOE VERA GEL 160ML', 'CONSUMER'],
      ['catalog-033324', 'ALOE VERA SOOTHING GEL 99%', 'CONSUMER'],
      ['catalog-745604648165', 'BUTTERFLY BREATHABLE 28 PCS', 'CONSUMER'],
      ['catalog-0745604648165', 'BUTTERFLY MAXI THICK XL 28PC', 'MISC'],
    ] as const;
    const loaded = await deps.catalogue.loadDefaultCatalogue({
      text: serializeSeedCsv(
        zeros.map(([sourceKey, name, manufacturer]) => ({
          sourceKey,
          productName: name,
          brandName: name,
          manufacturer,
          strength: null,
          dosageForm: null,
          productFamily: 'PHARMACEUTICAL' as const,
          controlledCandidate: false,
        }))
      ),
      version: 1,
      key: ZERO_KEY,
      batchSize: 4,
    });
    expect(loaded).toMatchObject({
      status: 'created',
      rowCount: zeros.length,
      inserted: zeros.length,
    });

    const applied = await deps.catalogue.applyDefaultCatalogue(ORG_D, loaded.versionId, {
      batchSize: 3,
    });
    expect(applied).toMatchObject({ created: zeros.length, matchedExisting: 0 });

    const held = await inOrg(ORG_D, (db) =>
      db.medicineCatalogueProvenance.findMany({
        where: { catalogueKey: ZERO_KEY },
        include: { medicine: true },
      })
    );
    expect(new Map(held.map((row) => [row.sourceKey, row.medicine.productName]))).toEqual(
      new Map(zeros.map(([sourceKey, name]) => [sourceKey, name]))
    );

    const again = await deps.catalogue.applyDefaultCatalogue(ORG_D, loaded.versionId, {
      batchSize: 3,
    });
    expect(again).toMatchObject({ created: 0, alreadyPresent: zeros.length });
  });
});
