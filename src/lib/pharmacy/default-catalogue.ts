import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { OrganizationStatus, PlatformJob, Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  DEFAULT_CATALOGUE_KEY,
  parseSeedCsv,
  presentationLabel,
  seedRowContent,
  type DefaultCatalogueSeedRow,
} from './default-catalogue-seed';

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
 * insert provenance but never update or delete it (RLS), so the flag sticks.
 *
 * NO DUPLICATES OF WHAT A PHARMACY ALREADY HAS. A medicine the tenant holds
 * from another route (manual entry, the importer wizard, a reference
 * connector) is matched by name, brand and presentation and skipped, reported
 * as `matchedExisting`. Every batch that creates medicines writes one tenant
 * audit row naming the job, requesting operator or backfill actor, and counts.
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
const OVERVIEW_ORGANIZATION_LIMIT = 500;
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
  /** Items the tenant already held from this catalogue; left untouched. */
  alreadyPresent: number;
  /** Of `created`, how many were NARCOTICS-class candidates held for review. */
  controlledCandidates: number;
  /** Items a newer version changed after the tenant got them. Reported, never applied. */
  upstreamChanged: number;
  upstreamChangedSample: string[];
  /**
   * Items skipped because the tenant already holds the same medicine from
   * another route (manual entry, the importer wizard, a reference connector).
   * Never duplicated, never overwritten — reported for the pharmacy to reconcile.
   */
  matchedExisting: number;
  matchedExistingSample: string[];
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

type CatalogueBatchResult = {
  last: string;
  full: boolean;
  created: number;
  alreadyPresent: number;
  controlledCandidates: number;
  changed: string[];
  matched: string[];
};

/** The comparison key for "the same medicine": case- and whitespace-insensitive. */
export function catalogueMatchText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

type ExistingMedicineRow = {
  id: string;
  productName: string;
  brandName: string | null;
  presentations: string[];
};

/**
 * Tenant medicines with no catalogue provenance whose product name matches one
 * of `names` (already normalised by {@link catalogueMatchText}). Run in the
 * tenant scope: RLS confines it to that pharmacy.
 */
async function existingNonCatalogueMedicines(
  db: ScopedDb,
  organizationId: string,
  names: string[]
): Promise<ExistingMedicineRow[]> {
  if (!names.length) return [];
  return db.$queryRaw<ExistingMedicineRow[]>`
    SELECT m.id, m."productName", m."brandName",
           COALESCE(array_remove(array_agg(p.presentation), NULL), ARRAY[]::text[]) AS presentations
      FROM pharmacy_medicines m
      LEFT JOIN pharmacy_presentations p
        ON p."organizationId" = m."organizationId" AND p."medicineId" = m.id
     WHERE m."organizationId" = ${organizationId}
       AND lower(btrim(regexp_replace(m."productName", '[[:space:]]+', ' ', 'g')))
         = ANY(${names}::text[])
       AND NOT EXISTS (
         SELECT 1 FROM pharmacy_medicine_catalogue_provenance c
          WHERE c."organizationId" = m."organizationId" AND c."medicineId" = m.id
       )
     GROUP BY m.id`;
}

/**
 * Whether a tenant already holds this catalogue item from another route: same
 * product name and brand, and either the same presentation label or nothing to
 * tell them apart (one side has no presentation). Deliberately conservative —
 * a skipped item is reported; a duplicated medicine is a dispensing hazard.
 */
function matchesExistingMedicine(
  item: {
    productName: string;
    brandName: string | null;
    strength: string | null;
    dosageForm: string | null;
  },
  existing: ExistingMedicineRow[]
): boolean {
  const name = catalogueMatchText(item.productName);
  const brand = catalogueMatchText(item.brandName);
  const label = catalogueMatchText(presentationLabel(item));
  return existing.some((medicine) => {
    if (catalogueMatchText(medicine.productName) !== name) return false;
    if (catalogueMatchText(medicine.brandName) !== brand) return false;
    if (!label || !medicine.presentations.length) return true;
    return medicine.presentations.some((value) => catalogueMatchText(value) === label);
  });
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
 * already hold into its own medicines. See the module comment for the rules.
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
    upstreamChanged: 0,
    upstreamChangedSample: [],
    matchedExisting: 0,
    matchedExistingSample: [],
  };

  let cursor: string | null = null;
  for (;;) {
    const after: string | null = cursor;
    const batch: CatalogueBatchResult | null = await withTenantDb(
      organizationId,
      async (db): Promise<CatalogueBatchResult | null> => {
        // Two applies for one tenant (provisioning job and a backfill, say)
        // would otherwise both see a source key as missing and race to it.
        const lockKey = `${DEFAULT_CATALOGUE_JOB}:${organizationId}`;
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const items = await db.platformMedicineCatalogueItem.findMany({
          where: { versionId: version.id, ...(after === null ? {} : { sourceKey: { gt: after } }) },
          orderBy: { sourceKey: 'asc' },
          take: batchSize,
        });
        if (!items.length) return null;

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

        // A medicine the pharmacy already holds from another route (manual
        // entry, the importer wizard, a reference connector) has no catalogue
        // provenance, so `held` cannot see it. Match it by name, brand and
        // presentation and skip it rather than create a duplicate beside it.
        const unheldNames = [
          ...new Set(
            items
              .filter((item) => !held.has(item.sourceKey))
              .map((item) => catalogueMatchText(item.productName))
          ),
        ];
        const existingMedicines = await existingNonCatalogueMedicines(
          db,
          organizationId,
          unheldNames
        );

        const changed: string[] = [];
        const matched: string[] = [];
        const missing: Array<(typeof items)[number] & { medicineId: string; digest: string }> = [];
        for (const item of items) {
          const digest = catalogueItemDigest(item);
          const existing = held.get(item.sourceKey);
          if (!existing) {
            if (matchesExistingMedicine(item, existingMedicines)) {
              matched.push(item.sourceKey);
            } else {
              missing.push({ ...item, medicineId: randomUUID(), digest });
            }
          } else if (
            existing.catalogueVersion < version.version &&
            existing.contentDigest !== digest
          ) {
            changed.push(item.sourceKey);
          }
        }

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
          await db.medicineCatalogueProvenance.createMany({
            data: missing.map((item) => ({
              organizationId,
              medicineId: item.medicineId,
              source: DEFAULT_CATALOGUE_SOURCE,
              catalogueKey: version.key,
              catalogueVersion: version.version,
              catalogueVersionId: version.id,
              sourceKey: item.sourceKey,
              contentDigest: item.digest,
              controlledCandidate: item.controlledCandidate,
            })),
          });
        }

        const controlledCandidates = missing.filter((item) => item.controlledCandidate).length;
        if (missing.length) {
          // One tenant audit row per batch that created medicines, in the same
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
              description: `Default medicine catalogue ${version.key} v${version.version}: created ${missing.length}, skipped ${matched.length} already held.`,
              targetType: 'PlatformMedicineCatalogueVersion',
              targetId: version.id,
              targetLabel: `${version.key} v${version.version}`,
              result: {
                created: missing.length,
                controlledCandidates,
                matchedExisting: matched.length,
                alreadyPresent: items.length - missing.length - matched.length,
                firstSourceKey: items[0]!.sourceKey,
                lastSourceKey: items[items.length - 1]!.sourceKey,
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

        return {
          last: items[items.length - 1]!.sourceKey,
          full: items.length === batchSize,
          created: missing.length,
          alreadyPresent: items.length - missing.length - matched.length,
          controlledCandidates,
          changed,
          matched,
        };
      },
      { skipDrain: true, timeout: 60_000 }
    );
    if (!batch) break;
    result.batches += 1;
    result.created += batch.created;
    result.alreadyPresent += batch.alreadyPresent;
    result.controlledCandidates += batch.controlledCandidates;
    result.upstreamChanged += batch.changed.length;
    result.upstreamChangedSample.push(
      ...batch.changed.slice(0, MAX_DIFF_SAMPLE - result.upstreamChangedSample.length)
    );
    result.matchedExisting += batch.matched.length;
    result.matchedExistingSample.push(
      ...batch.matched.slice(0, MAX_DIFF_SAMPLE - result.matchedExistingSample.length)
    );
    if (!batch.full) break;
    cursor = batch.last;
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
    /**
     * Catalogue items whose product name and brand match a medicine the
     * pharmacy already holds from another route. An upper bound on what the
     * apply will skip as already held (presentation is checked at apply time).
     */
    possibleExistingMatches: number;
    applied?: ApplyDefaultCatalogueResult;
    error?: string;
  }>;
};

/**
 * Dry-run overlap check: how many items of the version, not yet held from the
 * catalogue, share a product name and brand with a medicine the pharmacy
 * already holds from another route. Read-only, in the tenant's RLS scope.
 */
async function countPossibleExistingMatches(
  organizationId: string,
  versionId: string,
  catalogueKey: string
): Promise<number> {
  const rows = await withTenantDb(organizationId, (db) =>
    db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(DISTINCT i.id) AS count
        FROM platform_medicine_catalogue_items i
        JOIN pharmacy_medicines m
          ON m."organizationId" = ${organizationId}
         AND lower(btrim(regexp_replace(m."productName", '[[:space:]]+', ' ', 'g')))
           = lower(btrim(regexp_replace(i."productName", '[[:space:]]+', ' ', 'g')))
         AND lower(btrim(regexp_replace(COALESCE(m."brandName", ''), '[[:space:]]+', ' ', 'g')))
           = lower(btrim(regexp_replace(COALESCE(i."brandName", ''), '[[:space:]]+', ' ', 'g')))
       WHERE i."versionId" = ${versionId}
         AND NOT EXISTS (
           SELECT 1 FROM pharmacy_medicine_catalogue_provenance c
            WHERE c."organizationId" = m."organizationId" AND c."medicineId" = m.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM pharmacy_medicine_catalogue_provenance h
            WHERE h."organizationId" = ${organizationId}
              AND h."catalogueKey" = ${catalogueKey}
              AND h."sourceKey" = i."sourceKey"
         )`
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Apply a published catalogue version to every existing, non-terminal pharmacy
 * (or one, with `organizationId`). Dry-run unless `apply` is true: a dry run
 * only reads. Idempotent — a second apply creates nothing.
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
      possibleExistingMatches: 0,
    };
    try {
      entry.possibleExistingMatches = await countPossibleExistingMatches(
        organization.id,
        version.id,
        catalogueKey
      );
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
  /** More pharmacies exist than the console lists. */
  organizationsTruncated: boolean;
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

/** Read-only overview for the platform console. Run under `withPlatformDb`. */
export async function defaultCatalogueOverview(
  db: ScopedDb,
  catalogueKey = DEFAULT_CATALOGUE_KEY
): Promise<DefaultCatalogueOverview> {
  const [versions, listed] = await Promise.all([
    db.platformMedicineCatalogueVersion.findMany({
      where: { key: catalogueKey },
      orderBy: { version: 'desc' },
      take: 20,
    }),
    db.organization.findMany({
      where: { vertical: 'PHARMACY', status: { not: 'PURGED' } },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, status: true },
      take: OVERVIEW_ORGANIZATION_LIMIT + 1,
    }),
  ]);
  const organizationsTruncated = listed.length > OVERVIEW_ORGANIZATION_LIMIT;
  const organizations = listed.slice(0, OVERVIEW_ORGANIZATION_LIMIT);
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
    organizationsTruncated,
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
