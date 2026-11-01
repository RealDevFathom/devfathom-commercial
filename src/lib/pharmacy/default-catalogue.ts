import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type {
  OrganizationStatus,
  PlatformJob,
  PlatformMedicineCatalogueItem,
  Prisma,
} from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  DEFAULT_CATALOGUE_KEY,
  parseSeedCsv,
  presentationLabel,
  seedRowContent,
  type DefaultCatalogueSeedRow,
} from './default-catalogue-seed';
import {
  CATALOGUE_NAME_KEY_SQL_PATTERN,
  catalogueNameKeys,
  findHandEnteredMatches,
  linkedControlledCandidate,
  linkedHoldsFromSale,
  type HandEnteredMedicine,
} from './default-catalogue-match';

/**
 * Platform default medicine catalogue — the database half.
 *
 *  - {@link loadDefaultCatalogue} writes a seed file into the shared platform
 *    tables as one immutable, digest-pinned version.
 *  - {@link applyDefaultCatalogue} copies a published version into one
 *    pharmacy's own `Medicine` rows, inside that pharmacy's RLS scope.
 *  - {@link runDefaultCatalogueJob} is the `pharmacy.default-catalogue.v1`
 *    platform job that provisioning enqueues, so creating an organization never
 *    waits on, or fails because of, the catalogue.
 *  - {@link backfillDefaultCatalogue} applies it to pharmacies that already exist.
 *
 * WHY COPY RATHER THAN SHARE. Presentations, sale lines, purchase orders and
 * batches all reference a tenant `Medicine` by (organizationId, id). A shared,
 * read-only catalogue plus a per-tenant copy keeps every one of those foreign
 * keys and RLS policies exactly as they are.
 *
 * WHAT A COPY IS. A medicine, plus a presentation when the item names a
 * strength or dosage form, plus a {@link MedicineCatalogueProvenance} row.
 * Never a batch, lot, price or any stock: a new pharmacy holds zero of
 * everything. Every copy is created `saleable: false` and `controlled: false`
 * — the catalogue has no DRAP registration, and `assertSaleable` requires one
 * (with provenance) before a medicine may sell. Items the source filed under
 * NARCOTICS additionally carry `controlledCandidate` on their provenance row
 * for pharmacist review; the catalogue never invents a controlled flag. The
 * hold is enforced at publication: such a medicine cannot become saleable until
 * a reviewed `controlled` decision is published with it. Tenants may read and
 * insert provenance but never update or delete it (RLS), so the flag sticks,
 * and every insert must agree with the catalogue item and version it names
 * (`pharmacy_validate_catalogue_provenance`). A pharmacist completes a copy in
 * the reference review workbench (see `default-catalogue-review.ts`).
 *
 * NO DUPLICATES OF WHAT A PHARMACY ALREADY HAS. A catalogue item that is a
 * likely duplicate of a medicine the tenant entered by hand (manual entry, the
 * importer wizard, a reference connector) — same normalised brand/product
 * name, strength and dosage form, and manufacturer when both name one; see
 * `default-catalogue-match.ts` — is never copied. The existing medicine is
 * linked to the item through a provenance row (`linkedExisting`) and none of
 * its fields are written. A link to a NARCOTICS item carries the same
 * `controlledCandidate` review flag on its provenance row as a copy would, so
 * the pharmacist reviews the hand-entered medicine too. A copy starts
 * unsaleable, but a hand-entered medicine may already sell, so the link also
 * holds it from sale (`saleable: false`, the only field a link ever writes)
 * unless a reviewed `controlled` decision has already been published for it.
 * Publishing that decision — the review that releases a copy — releases it.
 * A second item matching an already-linked medicine is skipped. The backfill
 * dry run lists every such pair with the reason it matched, its NARCOTICS flag
 * and whether it would be held. Every batch that creates or links medicines
 * writes one tenant audit row naming the job, requesting operator or backfill
 * actor, and counts.
 *
 * IDEMPOTENT AND RESUMABLE. The provenance row is unique per (organization,
 * catalogue key, source key). Each batch commits on its own, under a per-tenant
 * advisory lock, and skips every source key the tenant already holds — so a
 * re-run, a retry after a crash, or a later catalogue version only ever adds
 * what is missing. A tenant medicine is never updated or deleted here; a later
 * version that changed an item the tenant holds is reported as a diff.
 */

export { DEFAULT_CATALOGUE_KEY } from './default-catalogue-seed';

export const DEFAULT_CATALOGUE_SOURCE = 'platform-default';
export const DEFAULT_CATALOGUE_JOB = 'pharmacy.default-catalogue.v1';
export const DEFAULT_CATALOGUE_BATCH_SIZE = 1_000;
const MAX_DIFF_SAMPLE = 100;
export const OVERVIEW_DEFAULT_PAGE_SIZE = 50;
export const OVERVIEW_MAX_PAGE_SIZE = 200;
const TERMINAL_STATUSES: OrganizationStatus[] = ['TERMINATED', 'PURGING', 'PURGED'];

export type DefaultCatalogueErrorCode =
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_PUBLISHED'
  | 'VERSION_CONFLICT'
  | 'LOAD_INCOMPLETE'
  | 'ORGANIZATION_NOT_FOUND'
  | 'NOT_A_PHARMACY'
  | 'ORGANIZATION_TERMINAL';

export class DefaultCatalogueError extends Error {
  constructor(
    readonly code: DefaultCatalogueErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DefaultCatalogueError';
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function batchSizeOf(value: number | undefined): number {
  const size = Math.floor(value ?? DEFAULT_CATALOGUE_BATCH_SIZE);
  return Math.max(1, Math.min(DEFAULT_CATALOGUE_BATCH_SIZE, size));
}

/** The digest of one item's content, as stored on the tenant's provenance row. */
export function catalogueItemDigest(item: Omit<DefaultCatalogueSeedRow, 'sourceKey'>): string {
  return sha256(seedRowContent(item));
}

/** Seed file bytes (gzipped or not) → its text and the digest a version is keyed on. */
export function decodeSeedFile(bytes: Buffer): { text: string; digest: string } {
  const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = gzipped ? gunzipSync(bytes) : bytes;
  return { text: raw.toString('utf8'), digest: sha256(raw) };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadDefaultCatalogueResult = {
  status: 'unchanged' | 'created' | 'resumed';
  versionId: string;
  key: string;
  version: number;
  digest: string;
  rowCount: number;
  inserted: number;
};

/**
 * Load a seed file as catalogue version `version` of `key`. Items are inserted
 * in batches of 1,000, each in its own platform transaction, idempotent on
 * (version, sourceKey) — so an interrupted load resumes where it stopped. The
 * version is published only once every row is present.
 *
 * Re-running with the same digest is a no-op. Reusing a version number for
 * different content, or loading the same content under a second version
 * number, is refused: a published catalogue version never changes.
 */
export async function loadDefaultCatalogue(input: {
  text: string;
  version: number;
  key?: string;
  batchSize?: number;
  now?: Date;
}): Promise<LoadDefaultCatalogueResult> {
  const key = input.key ?? DEFAULT_CATALOGUE_KEY;
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new DefaultCatalogueError(
      'VERSION_CONFLICT',
      'Catalogue version must be a positive integer.'
    );
  }
  const digest = sha256(Buffer.from(input.text, 'utf8'));
  const rows = parseSeedCsv(input.text);

  const prepared = await withPlatformDb(async (db) => {
    const [byVersion, byDigest] = await Promise.all([
      db.platformMedicineCatalogueVersion.findUnique({
        where: { key_version: { key, version: input.version } },
      }),
      db.platformMedicineCatalogueVersion.findUnique({ where: { key_digest: { key, digest } } }),
    ]);
    if (byVersion && byVersion.digest !== digest) {
      throw new DefaultCatalogueError(
        'VERSION_CONFLICT',
        `${key} v${input.version} is already loaded with different content; load a new version.`
      );
    }
    if (byDigest && byDigest.version !== input.version) {
      throw new DefaultCatalogueError(
        'VERSION_CONFLICT',
        `This seed is already loaded as ${key} v${byDigest.version}.`
      );
    }
    if (byVersion) return { record: byVersion, created: false };
    const record = await db.platformMedicineCatalogueVersion.create({
      data: { key, version: input.version, digest, rowCount: rows.length },
    });
    return { record, created: true };
  });

  const result = {
    versionId: prepared.record.id,
    key,
    version: input.version,
    digest,
    rowCount: rows.length,
  };
  if (prepared.record.publishedAt) return { status: 'unchanged', ...result, inserted: 0 };

  let inserted = 0;
  for (const batch of chunks(rows, batchSizeOf(input.batchSize))) {
    const created = await withPlatformDb((db) =>
      db.platformMedicineCatalogueItem.createMany({
        data: batch.map((row) => ({ versionId: prepared.record.id, ...row })),
        skipDuplicates: true,
      })
    );
    inserted += created.count;
  }

  await withPlatformDb(async (db) => {
    const loaded = await db.platformMedicineCatalogueItem.count({
      where: { versionId: prepared.record.id },
    });
    if (loaded !== rows.length) {
      throw new DefaultCatalogueError(
        'LOAD_INCOMPLETE',
        `${key} v${input.version} holds ${loaded} items; the seed has ${rows.length}.`
      );
    }
    await db.platformMedicineCatalogueVersion.updateMany({
      where: { id: prepared.record.id, publishedAt: null },
      data: { publishedAt: input.now ?? new Date() },
    });
  });

  return { status: prepared.created ? 'created' : 'resumed', ...result, inserted };
}

/** The highest published version of a catalogue, or null when none is loaded yet. */
export function latestPublishedCatalogueVersion(db: ScopedDb, key = DEFAULT_CATALOGUE_KEY) {
  return db.platformMedicineCatalogueVersion.findFirst({
    where: { key, publishedAt: { not: null } },
    orderBy: { version: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Materialiser
// ---------------------------------------------------------------------------

export type ApplyDefaultCatalogueResult = {
  organizationId: string;
  catalogueKey: string;
  versionId: string;
  version: number;
  batches: number;
  /** Medicines this run created. */
  created: number;
  /** Items the tenant already held from this catalogue (created or linked); left untouched. */
  alreadyPresent: number;
  /**
   * NARCOTICS-class candidates this run flagged for review: copies it created
   * plus hand-entered medicines it linked (`linkedControlledCandidates`).
   */
  controlledCandidates: number;
  /** Of `linkedExisting`, how many were linked to a NARCOTICS item and flagged for review. */
  linkedControlledCandidates: number;
  /**
   * Of `linkedControlledCandidates`, how many saleable hand-entered medicines
   * this run held from sale until a pharmacist publishes a reviewed
   * `controlled` decision.
   */
  heldFromSale: number;
  /** Items a newer version changed after the tenant got them. Reported, never applied. */
  upstreamChanged: number;
  upstreamChangedSample: string[];
  /**
   * Items not created because they are likely duplicates of a medicine the
   * pharmacy entered by hand (manual entry, the importer wizard, a reference
   * connector): `linkedExisting` of them were linked to that medicine through a
   * provenance row, the rest matched a medicine already linked to another item.
   */
  matchedExisting: number;
  /** Of `matchedExisting`, how many this run linked. */
  linkedExisting: number;
  matchedExistingSample: CatalogueDuplicateMatch[];
};

/**
 * One likely duplicate between a catalogue item and a medicine the pharmacy
 * entered by hand. `link`: the apply records a provenance row naming the
 * medicine instead of creating a copy. `skip`: the medicine is already linked
 * to `linkedSourceKey`, so this item is neither created nor linked.
 */
export type CatalogueDuplicateMatch = {
  sourceKey: string;
  catalogueName: string;
  medicineId: string;
  medicineName: string;
  action: 'link' | 'skip';
  linkedSourceKey?: string;
  reason: string;
  /**
   * The catalogue item was filed under NARCOTICS. On a `link`, the link's
   * provenance row carries the `controlledCandidate` review flag.
   */
  controlledCandidate: boolean;
  /**
   * The `link` holds the medicine from sale (`saleable: false`) until a
   * pharmacist publishes a reviewed `controlled` decision: it is NARCOTICS,
   * currently saleable, and has no published reviewed decision yet. Always
   * false for a `skip`.
   */
  holdFromSale: boolean;
};

/** Who caused an apply, for the tenant audit trail. */
export type DefaultCatalogueAuditContext = {
  trigger: 'provisioning-job' | 'backfill' | 'direct';
  /** The platform job that ran the apply, when there is one. */
  jobId?: string | null;
  /** The platform operator who requested the job or ran the backfill. */
  requestedById?: string | null;
  /** A human-readable actor (operator email or name) — required for a CLI backfill. */
  actorName?: string | null;
};

type CatalogueVersionRef = { id: string; key: string; version: number };
type PlannedItem = PlatformMedicineCatalogueItem & { digest: string };

type CatalogueBatchPlan = {
  items: PlatformMedicineCatalogueItem[];
  /** Not held, not a likely duplicate: create a medicine. */
  missing: Array<PlannedItem & { medicineId: string }>;
  /** Not held, a likely duplicate: link the existing medicine. */
  linked: Array<PlannedItem & { medicineId: string; holdFromSale: boolean }>;
  /** Every likely duplicate in the batch, linked or skipped. */
  duplicates: CatalogueDuplicateMatch[];
  /** Held items a newer version changed. */
  changed: string[];
};

type CandidateMedicine = HandEnteredMedicine & {
  linkedSourceKey: string | null;
  /** The NARCOTICS review flag the medicine already carries, if any. */
  controlledCandidate: boolean;
  saleable: boolean;
  /** A reviewed `controlled` decision has been published for the medicine. */
  controlledReviewed: boolean;
};

/**
 * Tenant medicines a catalogue item may be a hand-entered duplicate of: no
 * catalogue provenance, or provenance that only links them (`linkedExisting`) —
 * never a medicine the catalogue itself created. Prefiltered by normalised
 * product or brand name in SQL; {@link findHandEnteredMatches} decides. Run in
 * the tenant scope: RLS confines it to that pharmacy.
 */
async function handEnteredCandidates(
  db: ScopedDb,
  organizationId: string,
  nameKeys: string[]
): Promise<CandidateMedicine[]> {
  if (!nameKeys.length) return [];
  const ids = await db.$queryRaw<Array<{ id: string }>>`
    SELECT m.id
      FROM pharmacy_medicines m
      LEFT JOIN pharmacy_medicine_catalogue_provenance c
        ON c."organizationId" = m."organizationId" AND c."medicineId" = m.id
     WHERE m."organizationId" = ${organizationId}
       AND (c.id IS NULL OR c."linkedExisting")
       AND (
         lower(regexp_replace(m."productName", ${CATALOGUE_NAME_KEY_SQL_PATTERN}, '', 'g'))
           = ANY(${nameKeys}::text[])
         OR lower(regexp_replace(
              COALESCE(m."brandName", ''), ${CATALOGUE_NAME_KEY_SQL_PATTERN}, '', 'g'
            )) = ANY(${nameKeys}::text[])
       )`;
  if (!ids.length) return [];
  const medicines = await db.medicine.findMany({
    where: { organizationId, id: { in: ids.map(({ id }) => id) } },
    select: {
      id: true,
      productName: true,
      brandName: true,
      manufacturer: true,
      strengths: { select: { value: true, unit: true } },
      presentations: { select: { dosageForm: true } },
      catalogueProvenance: { select: { sourceKey: true, controlledCandidate: true } },
      saleable: true,
      // The decision the publication hold demands of a NARCOTICS candidate:
      // a reviewed `controlled` assertion in a published batch.
      provenance: {
        where: {
          field: 'controlled',
          status: { in: ['ACCEPTED', 'CORRECTED'] },
          publicationEntries: { some: { batch: { status: 'PUBLISHED' } } },
        },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: { id: 'asc' },
  });
  return medicines.map((medicine) => ({
    id: medicine.id,
    productName: medicine.productName,
    brandName: medicine.brandName,
    manufacturer: medicine.manufacturer,
    strengths: medicine.strengths,
    dosageForms: medicine.presentations.map((presentation) => presentation.dosageForm),
    linkedSourceKey: medicine.catalogueProvenance?.sourceKey ?? null,
    controlledCandidate: medicine.catalogueProvenance?.controlledCandidate ?? false,
    saleable: medicine.saleable,
    controlledReviewed: medicine.provenance.length > 0,
  }));
}

/**
 * Decide, read-only, what one batch of a version means for one pharmacy:
 * which items it already holds, which are likely duplicates of a medicine it
 * entered by hand (link, or skip when that medicine is already linked), and
 * which must be created. The apply and the backfill dry run share this, so the
 * dry run lists exactly what the apply would do.
 *
 * `claimed` (medicine id → source key) carries links planned by earlier batches
 * of the same run, so a dry run — which writes nothing — still never plans two
 * items onto one medicine.
 */
async function planCatalogueBatch(
  db: ScopedDb,
  organizationId: string,
  version: CatalogueVersionRef,
  after: string | null,
  batchSize: number,
  claimed: Map<string, string>
): Promise<CatalogueBatchPlan | null> {
  const items = await db.platformMedicineCatalogueItem.findMany({
    where: { versionId: version.id, ...(after === null ? {} : { sourceKey: { gt: after } }) },
    orderBy: { sourceKey: 'asc' },
    take: batchSize,
  });
  if (!items.length) return null;

  // Source keys are exact strings everywhere: `catalog-0` and `catalog-00`
  // are different products and are looked up, held and linked separately.
  const held = new Map(
    (
      await db.medicineCatalogueProvenance.findMany({
        where: {
          organizationId,
          catalogueKey: version.key,
          sourceKey: { in: items.map((item) => item.sourceKey) },
        },
        select: { sourceKey: true, contentDigest: true, catalogueVersion: true },
      })
    ).map((row) => [row.sourceKey, row])
  );

  const unheld = items.filter((item) => !held.has(item.sourceKey));
  const candidates = await handEnteredCandidates(db, organizationId, catalogueNameKeys(unheld));
  for (const candidate of candidates) {
    if (candidate.linkedSourceKey && !claimed.has(candidate.id)) {
      claimed.set(candidate.id, candidate.linkedSourceKey);
    }
  }

  const plan: CatalogueBatchPlan = { items, missing: [], linked: [], duplicates: [], changed: [] };
  for (const item of items) {
    const digest = catalogueItemDigest(item);
    const existing = held.get(item.sourceKey);
    if (existing) {
      if (existing.catalogueVersion < version.version && existing.contentDigest !== digest) {
        plan.changed.push(item.sourceKey);
      }
      continue;
    }
    const matches = findHandEnteredMatches(item, candidates);
    if (!matches.length) {
      plan.missing.push({ ...item, digest, medicineId: randomUUID() });
      continue;
    }
    // Prefer a medicine no other item has claimed; the provenance row is one
    // per medicine, so a second item matching the same medicine is skipped.
    const open = matches.find((match) => !claimed.has(match.medicine.id));
    const chosen = open ?? matches[0]!;
    const duplicate: CatalogueDuplicateMatch = {
      sourceKey: item.sourceKey,
      catalogueName: item.brandName ?? item.productName,
      medicineId: chosen.medicine.id,
      medicineName: chosen.medicine.productName,
      action: open ? 'link' : 'skip',
      reason: chosen.reason,
      controlledCandidate: item.controlledCandidate,
      holdFromSale: false,
    };
    if (open) {
      claimed.set(open.medicine.id, item.sourceKey);
      // A NARCOTICS item flags the hand-entered medicine for pharmacist review
      // through the link's provenance row, as it would a copy, and holds it
      // from sale until that review is published (a copy starts unsaleable).
      const controlledCandidate = linkedControlledCandidate(item, open.medicine);
      const holdFromSale = linkedHoldsFromSale(controlledCandidate, open.medicine);
      duplicate.controlledCandidate = controlledCandidate;
      duplicate.holdFromSale = holdFromSale;
      plan.linked.push({
        ...item,
        digest,
        medicineId: open.medicine.id,
        controlledCandidate,
        holdFromSale,
      });
    } else {
      duplicate.linkedSourceKey = claimed.get(chosen.medicine.id);
    }
    plan.duplicates.push(duplicate);
  }
  return plan;
}

async function assertApplicable(organizationId: string, versionId: string) {
  return withPlatformDb(async (db) => {
    const [version, organization] = await Promise.all([
      db.platformMedicineCatalogueVersion.findUnique({ where: { id: versionId } }),
      db.organization.findUnique({
        where: { id: organizationId },
        select: { vertical: true, status: true },
      }),
    ]);
    if (!version) {
      throw new DefaultCatalogueError('VERSION_NOT_FOUND', 'Catalogue version not found.');
    }
    if (!version.publishedAt) {
      throw new DefaultCatalogueError(
        'VERSION_NOT_PUBLISHED',
        `${version.key} v${version.version} has not finished loading.`
      );
    }
    if (!organization) {
      throw new DefaultCatalogueError('ORGANIZATION_NOT_FOUND', 'Organization not found.');
    }
    if (organization.vertical !== 'PHARMACY') {
      throw new DefaultCatalogueError(
        'NOT_A_PHARMACY',
        'The default medicine catalogue only applies to pharmacy organizations.'
      );
    }
    if (TERMINAL_STATUSES.includes(organization.status)) {
      throw new DefaultCatalogueError(
        'ORGANIZATION_TERMINAL',
        `The organization is ${organization.status}; nothing is materialised into it.`
      );
    }
    return version;
  });
}

/**
 * Copy every item of a published catalogue version that the pharmacy does not
 * already hold into its own medicines, and link — never copy — the items that
 * are likely duplicates of a medicine it entered by hand. See the module
 * comment for the rules.
 */
export async function applyDefaultCatalogue(
  organizationId: string,
  versionId: string,
  options: { batchSize?: number; audit?: DefaultCatalogueAuditContext } = {}
): Promise<ApplyDefaultCatalogueResult> {
  const version = await assertApplicable(organizationId, versionId);
  const batchSize = batchSizeOf(options.batchSize);
  const audit: DefaultCatalogueAuditContext = options.audit ?? { trigger: 'direct' };
  const result: ApplyDefaultCatalogueResult = {
    organizationId,
    catalogueKey: version.key,
    versionId: version.id,
    version: version.version,
    batches: 0,
    created: 0,
    alreadyPresent: 0,
    controlledCandidates: 0,
    linkedControlledCandidates: 0,
    heldFromSale: 0,
    upstreamChanged: 0,
    upstreamChangedSample: [],
    matchedExisting: 0,
    linkedExisting: 0,
    matchedExistingSample: [],
  };

  const claimed = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const after: string | null = cursor;
    const batch: CatalogueBatchPlan | null = await withTenantDb(
      organizationId,
      async (db): Promise<CatalogueBatchPlan | null> => {
        // Two applies for one tenant (provisioning job and a backfill, say)
        // would otherwise both see a source key as missing and race to it.
        const lockKey = `${DEFAULT_CATALOGUE_JOB}:${organizationId}`;
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const plan = await planCatalogueBatch(
          db,
          organizationId,
          version,
          after,
          batchSize,
          claimed
        );
        if (!plan) return null;
        const { items, missing, linked, duplicates } = plan;

        if (missing.length) {
          await db.medicine.createMany({
            data: missing.map((item) => ({
              id: item.medicineId,
              organizationId,
              productName: item.productName,
              brandName: item.brandName,
              manufacturer: item.manufacturer,
              productFamily: item.productFamily,
              controlled: false,
              saleable: false,
            })),
          });
          const presentations: Prisma.PresentationCreateManyInput[] = [];
          for (const item of missing) {
            const label = presentationLabel(item);
            if (label) {
              presentations.push({
                organizationId,
                medicineId: item.medicineId,
                dosageForm: item.dosageForm,
                presentation: label,
              });
            }
          }
          if (presentations.length) await db.presentation.createMany({ data: presentations });
        }
        // Created and linked items alike get a provenance row; a linked row
        // names the pharmacy's own medicine and writes none of its fields.
        if (missing.length || linked.length) {
          await db.medicineCatalogueProvenance.createMany({
            data: [
              ...missing.map((item) => ({ item, linkedExisting: false })),
              ...linked.map((item) => ({ item, linkedExisting: true })),
            ].map(({ item, linkedExisting }) => ({
              organizationId,
              medicineId: item.medicineId,
              source: DEFAULT_CATALOGUE_SOURCE,
              catalogueKey: version.key,
              catalogueVersion: version.version,
              catalogueVersionId: version.id,
              sourceKey: item.sourceKey,
              contentDigest: item.digest,
              controlledCandidate: item.controlledCandidate,
              linkedExisting,
            })),
          });
        }

        // Hold every NARCOTICS link the plan marked from sale, in the same
        // transaction as its provenance row. `saleable` is the only field a
        // link writes; publishing a reviewed `controlled` decision releases it.
        const held = linked.filter((item) => item.holdFromSale);
        if (held.length) {
          await db.medicine.updateMany({
            where: {
              organizationId,
              id: { in: held.map((item) => item.medicineId) },
              saleable: true,
            },
            data: { saleable: false },
          });
        }

        const linkedControlled = linked.filter((item) => item.controlledCandidate);
        const controlledCandidates =
          missing.filter((item) => item.controlledCandidate).length + linkedControlled.length;
        const skipped = duplicates.length - linked.length;
        if (missing.length || linked.length) {
          // One tenant audit row per batch that wrote anything, in the same
          // transaction as the writes it describes. Platform operators are not
          // tenant users, so the actor is recorded as SYSTEM with the operator
          // and job named in metadata.
          await db.auditLog.create({
            data: {
              organizationId,
              actorType: 'SYSTEM',
              actorName: audit.actorName ?? null,
              source: 'SYSTEM',
              category: 'PHARMACY',
              operation: 'CREATE',
              action: `${DEFAULT_CATALOGUE_JOB}.apply`,
              description: `Default medicine catalogue ${version.key} v${version.version}: created ${missing.length}, linked ${linked.length} hand-entered, skipped ${skipped} duplicate; ${controlledCandidates} NARCOTICS flagged for review, ${held.length} hand-entered held from sale.`,
              targetType: 'PlatformMedicineCatalogueVersion',
              targetId: version.id,
              targetLabel: `${version.key} v${version.version}`,
              result: {
                created: missing.length,
                controlledCandidates,
                linkedControlledCandidates: linkedControlled.length,
                heldFromSale: held.length,
                linkedExisting: linked.length,
                matchedExisting: duplicates.length,
                alreadyPresent: items.length - missing.length - duplicates.length,
                firstSourceKey: items[0]!.sourceKey,
                lastSourceKey: items[items.length - 1]!.sourceKey,
                linked: linked.map((item) => ({
                  sourceKey: item.sourceKey,
                  medicineId: item.medicineId,
                  controlledCandidate: item.controlledCandidate,
                  heldFromSale: item.holdFromSale,
                })),
              },
              metadata: {
                trigger: audit.trigger,
                jobId: audit.jobId ?? null,
                requestedById: audit.requestedById ?? null,
                actorName: audit.actorName ?? null,
              },
            },
          });
        }
        return plan;
      },
      { skipDrain: true, timeout: 60_000 }
    );
    if (!batch) break;
    result.batches += 1;
    result.created += batch.missing.length;
    result.alreadyPresent += batch.items.length - batch.missing.length - batch.duplicates.length;
    const linkedControlled = batch.linked.filter((item) => item.controlledCandidate).length;
    result.controlledCandidates +=
      batch.missing.filter((item) => item.controlledCandidate).length + linkedControlled;
    result.linkedControlledCandidates += linkedControlled;
    result.heldFromSale += batch.linked.filter((item) => item.holdFromSale).length;
    result.upstreamChanged += batch.changed.length;
    result.upstreamChangedSample.push(
      ...batch.changed.slice(0, MAX_DIFF_SAMPLE - result.upstreamChangedSample.length)
    );
    result.matchedExisting += batch.duplicates.length;
    result.linkedExisting += batch.linked.length;
    result.matchedExistingSample.push(
      ...batch.duplicates.slice(0, MAX_DIFF_SAMPLE - result.matchedExistingSample.length)
    );
    if (batch.items.length < batchSize) break;
    cursor = batch.items[batch.items.length - 1]!.sourceKey;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Provisioning job
// ---------------------------------------------------------------------------

function payloadString(payload: Prisma.JsonValue | null, key: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Queue the catalogue for a newly created pharmacy. Called inside the
 * organization-create transaction: it only inserts a job row, so creating the
 * organization never waits on the catalogue and a catalogue failure can never
 * roll the organization back. The job records its own status and can be
 * retried from the platform console.
 */
export function enqueueDefaultCatalogueForNewPharmacy(
  db: ScopedDb,
  input: { organizationId: string; requestedById: string | null }
) {
  return db.platformJob.create({
    data: {
      organizationId: input.organizationId,
      type: 'PHARMACY_DEFAULT_CATALOGUE_V1',
      requestedById: input.requestedById,
      payload: { catalogueKey: DEFAULT_CATALOGUE_KEY, reason: 'provisioning' },
      idempotencyKey: `${DEFAULT_CATALOGUE_JOB}:${input.organizationId}:provisioning`,
    },
  });
}

export type DefaultCatalogueJobResult =
  | ApplyDefaultCatalogueResult
  | { status: 'NO_PUBLISHED_VERSION'; organizationId: string; catalogueKey: string };

/**
 * The `pharmacy.default-catalogue.v1` handler. Runs outside any surrounding
 * transaction — each batch commits on its own — so it is dispatched before the
 * job runner opens its usual platform transaction.
 *
 * With no published version yet (a fresh environment), the job succeeds with
 * `NO_PUBLISHED_VERSION` rather than failing: nothing is wrong with the
 * organization, and the backfill applies the catalogue once it is loaded.
 */
export async function runDefaultCatalogueJob(
  job: Pick<PlatformJob, 'organizationId' | 'payload'> &
    Partial<Pick<PlatformJob, 'id' | 'requestedById'>>,
  options: { batchSize?: number } = {}
): Promise<DefaultCatalogueJobResult> {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error(`${DEFAULT_CATALOGUE_JOB} requires an organization.`);
  const catalogueKey = payloadString(job.payload, 'catalogueKey') ?? DEFAULT_CATALOGUE_KEY;
  const requestedVersionId = payloadString(job.payload, 'versionId');
  const versionId =
    requestedVersionId ??
    (await withPlatformDb((db) => latestPublishedCatalogueVersion(db, catalogueKey)))?.id;
  if (!versionId) return { status: 'NO_PUBLISHED_VERSION', organizationId, catalogueKey };
  return applyDefaultCatalogue(organizationId, versionId, {
    ...options,
    audit: {
      trigger: 'provisioning-job',
      jobId: job.id ?? null,
      requestedById: job.requestedById ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export type BackfillDefaultCatalogueReport = {
  mode: 'dry-run' | 'apply';
  catalogueKey: string;
  versionId: string;
  version: number;
  rowCount: number;
  organizations: Array<{
    organizationId: string;
    slug: string;
    status: string;
    heldBefore: number;
    missingBefore: number;
    /** Items the apply would create (exact, from the same plan the apply runs). */
    wouldCreate: number;
    /** `likelyDuplicates.length`. */
    possibleExistingMatches: number;
    /**
     * NARCOTICS-class candidates the apply would flag for review: copies it
     * would create plus hand-entered medicines it would link.
     */
    controlledCandidates: number;
    /** Hand-entered medicines the apply would link to a NARCOTICS item and hold from sale. */
    wouldHoldFromSale: number;
    /**
     * Every catalogue item, not yet held, that is a likely duplicate of a
     * medicine the pharmacy entered by hand — with the existing medicine, why
     * they matched, its NARCOTICS flag and whether the link would hold the
     * medicine from sale. `link` items are linked on apply, never copied.
     */
    likelyDuplicates: CatalogueDuplicateMatch[];
    applied?: ApplyDefaultCatalogueResult;
    error?: string;
  }>;
};

/**
 * The dry-run plan for one pharmacy: what the apply would create and every
 * likely hand-entered duplicate it would link or skip. Read-only, batch by
 * batch in the tenant's RLS scope, through the same planner as the apply.
 */
async function planDefaultCatalogue(
  organizationId: string,
  version: CatalogueVersionRef,
  batchSize: number
): Promise<{
  wouldCreate: number;
  controlledCandidates: number;
  wouldHoldFromSale: number;
  likelyDuplicates: CatalogueDuplicateMatch[];
}> {
  const claimed = new Map<string, string>();
  const likelyDuplicates: CatalogueDuplicateMatch[] = [];
  let wouldCreate = 0;
  let controlledCandidates = 0;
  let wouldHoldFromSale = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const plan: CatalogueBatchPlan | null = await withTenantDb(
      organizationId,
      (db) => planCatalogueBatch(db, organizationId, version, cursor, batchSize, claimed),
      { skipDrain: true, timeout: 60_000 }
    );
    if (!plan) break;
    wouldCreate += plan.missing.length;
    controlledCandidates += [...plan.missing, ...plan.linked].filter(
      (item) => item.controlledCandidate
    ).length;
    wouldHoldFromSale += plan.linked.filter((item) => item.holdFromSale).length;
    likelyDuplicates.push(...plan.duplicates);
    if (plan.items.length < batchSize) break;
    after = plan.items[plan.items.length - 1]!.sourceKey;
  }
  return { wouldCreate, controlledCandidates, wouldHoldFromSale, likelyDuplicates };
}

/**
 * Apply a published catalogue version to every existing, non-terminal pharmacy
 * (or one, with `organizationId`). Dry-run unless `apply` is true: a dry run
 * only reads, and lists every likely hand-entered duplicate; an apply links
 * those instead of copying them. Idempotent — a second apply creates and
 * links nothing.
 */
export async function backfillDefaultCatalogue(input: {
  apply: boolean;
  organizationId?: string;
  catalogueKey?: string;
  version?: number;
  batchSize?: number;
  /** Who is running the backfill (operator email or name), recorded in each tenant's audit log. */
  actor?: string;
}): Promise<BackfillDefaultCatalogueReport> {
  const catalogueKey = input.catalogueKey ?? DEFAULT_CATALOGUE_KEY;
  const { version, organizations, held } = await withPlatformDb(async (db) => {
    const selected =
      input.version === undefined
        ? await latestPublishedCatalogueVersion(db, catalogueKey)
        : await db.platformMedicineCatalogueVersion.findUnique({
            where: { key_version: { key: catalogueKey, version: input.version } },
          });
    if (!selected) {
      throw new DefaultCatalogueError(
        'VERSION_NOT_FOUND',
        input.version === undefined
          ? `No published ${catalogueKey} catalogue version is loaded.`
          : `${catalogueKey} v${input.version} is not loaded.`
      );
    }
    if (!selected.publishedAt) {
      throw new DefaultCatalogueError(
        'VERSION_NOT_PUBLISHED',
        `${catalogueKey} v${selected.version} has not finished loading.`
      );
    }
    const pharmacies = await db.organization.findMany({
      where: {
        vertical: 'PHARMACY',
        status: { notIn: TERMINAL_STATUSES },
        ...(input.organizationId ? { id: input.organizationId } : {}),
      },
      select: { id: true, slug: true, status: true },
      orderBy: { id: 'asc' },
    });
    const counts = await db.medicineCatalogueProvenance.groupBy({
      by: ['organizationId'],
      where: { catalogueKey, organizationId: { in: pharmacies.map((org) => org.id) } },
      _count: { _all: true },
    });
    return {
      version: selected,
      organizations: pharmacies,
      held: new Map(counts.map((row) => [row.organizationId, row._count._all])),
    };
  });
  if (input.organizationId && !organizations.length) {
    throw new DefaultCatalogueError(
      'ORGANIZATION_NOT_FOUND',
      'No active pharmacy organization has that id.'
    );
  }

  const report: BackfillDefaultCatalogueReport = {
    mode: input.apply ? 'apply' : 'dry-run',
    catalogueKey,
    versionId: version.id,
    version: version.version,
    rowCount: version.rowCount,
    organizations: [],
  };
  for (const organization of organizations) {
    const heldBefore = held.get(organization.id) ?? 0;
    const entry: BackfillDefaultCatalogueReport['organizations'][number] = {
      organizationId: organization.id,
      slug: organization.slug,
      status: organization.status,
      heldBefore,
      // An upper bound: items held from an older version may not be in this one.
      missingBefore: Math.max(0, version.rowCount - heldBefore),
      wouldCreate: 0,
      possibleExistingMatches: 0,
      controlledCandidates: 0,
      wouldHoldFromSale: 0,
      likelyDuplicates: [],
    };
    try {
      const plan = await planDefaultCatalogue(
        organization.id,
        version,
        batchSizeOf(input.batchSize)
      );
      entry.wouldCreate = plan.wouldCreate;
      entry.controlledCandidates = plan.controlledCandidates;
      entry.wouldHoldFromSale = plan.wouldHoldFromSale;
      entry.likelyDuplicates = plan.likelyDuplicates;
      entry.possibleExistingMatches = plan.likelyDuplicates.length;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    if (input.apply && !entry.error) {
      try {
        entry.applied = await applyDefaultCatalogue(organization.id, version.id, {
          batchSize: input.batchSize,
          audit: { trigger: 'backfill', actorName: input.actor ?? null },
        });
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
    report.organizations.push(entry);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Platform console read model
// ---------------------------------------------------------------------------

export type DefaultCatalogueOverview = {
  versions: Array<{
    id: string;
    key: string;
    version: number;
    digest: string;
    rowCount: number;
    publishedAt: Date | null;
    createdAt: Date;
  }>;
  /** Server-side pagination of `organizations`: 1-based page, clamped to the last page. */
  page: number;
  pageSize: number;
  /** Every listed pharmacy (not PURGED), across all pages. */
  totalOrganizations: number;
  pageCount: number;
  organizations: Array<{
    id: string;
    displayName: string;
    status: string;
    held: number;
    controlledCandidates: number;
    latestJob: {
      id: string;
      status: string;
      error: string | null;
      attempts: number;
      maxAttempts: number;
      finishedAt: Date | null;
      result: Prisma.JsonValue | null;
    } | null;
  }>;
};

/** A page request from the URL → a safe page and page size. */
export function overviewPageRequest(input: { page?: unknown; pageSize?: unknown }): {
  page: number;
  pageSize: number;
} {
  const whole = (value: unknown): number => {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'number') return Number.isInteger(first) ? first : NaN;
    return typeof first === 'string' && /^\d{1,6}$/.test(first) ? Number(first) : NaN;
  };
  const page = whole(input.page);
  const pageSize = whole(input.pageSize);
  return {
    page: page >= 1 ? page : 1,
    pageSize:
      pageSize >= 1 ? Math.min(OVERVIEW_MAX_PAGE_SIZE, pageSize) : OVERVIEW_DEFAULT_PAGE_SIZE,
  };
}

/**
 * Read-only overview for the platform console. Run under `withPlatformDb`.
 *
 * Pharmacies are paginated on the server: a stable order (display name, then
 * id, so equal names never swap between pages), `page`/`pageSize` with a total
 * count, and a page past the end clamped to the last page.
 */
export async function defaultCatalogueOverview(
  db: ScopedDb,
  options: { catalogueKey?: string; page?: number; pageSize?: number } = {}
): Promise<DefaultCatalogueOverview> {
  const catalogueKey = options.catalogueKey ?? DEFAULT_CATALOGUE_KEY;
  const request = overviewPageRequest(options);
  const pharmacies: Prisma.OrganizationWhereInput = {
    vertical: 'PHARMACY',
    status: { not: 'PURGED' },
  };
  const [versions, totalOrganizations] = await Promise.all([
    db.platformMedicineCatalogueVersion.findMany({
      where: { key: catalogueKey },
      orderBy: { version: 'desc' },
      take: 20,
    }),
    db.organization.count({ where: pharmacies }),
  ]);
  const pageCount = Math.max(1, Math.ceil(totalOrganizations / request.pageSize));
  const page = Math.min(request.page, pageCount);
  const organizations = await db.organization.findMany({
    where: pharmacies,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    select: { id: true, displayName: true, status: true },
    skip: (page - 1) * request.pageSize,
    take: request.pageSize,
  });
  const ids = organizations.map((organization) => organization.id);
  const [held, controlled, jobs] = await Promise.all([
    db.medicineCatalogueProvenance.groupBy({
      by: ['organizationId'],
      where: { catalogueKey, organizationId: { in: ids } },
      _count: { _all: true },
    }),
    db.medicineCatalogueProvenance.groupBy({
      by: ['organizationId'],
      where: { catalogueKey, organizationId: { in: ids }, controlledCandidate: true },
      _count: { _all: true },
    }),
    // The latest job per pharmacy, however many jobs each one has run.
    db.platformJob.findMany({
      where: { type: 'PHARMACY_DEFAULT_CATALOGUE_V1', organizationId: { in: ids } },
      distinct: ['organizationId'],
      orderBy: [{ organizationId: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        organizationId: true,
        status: true,
        error: true,
        attempts: true,
        maxAttempts: true,
        finishedAt: true,
        result: true,
      },
    }),
  ]);
  const heldBy = new Map(held.map((row) => [row.organizationId, row._count._all]));
  const controlledBy = new Map(controlled.map((row) => [row.organizationId, row._count._all]));
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (job.organizationId && !latestJob.has(job.organizationId)) {
      latestJob.set(job.organizationId, job);
    }
  }
  return {
    page,
    pageSize: request.pageSize,
    totalOrganizations,
    pageCount,
    versions: versions.map(({ id, key, version, digest, rowCount, publishedAt, createdAt }) => ({
      id,
      key,
      version,
      digest,
      rowCount,
      publishedAt,
      createdAt,
    })),
    organizations: organizations.map((organization) => {
      const job = latestJob.get(organization.id);
      return {
        ...organization,
        held: heldBy.get(organization.id) ?? 0,
        controlledCandidates: controlledBy.get(organization.id) ?? 0,
        latestJob: job
          ? {
              id: job.id,
              status: job.status,
              error: job.error,
              attempts: job.attempts,
              maxAttempts: job.maxAttempts,
              finishedAt: job.finishedAt,
              result: job.result,
            }
          : null,
      };
    }),
  };
}
