/**
 * DEV-751 — one-off legacy capture-receipt backfill for pharmacy SOP proof.
 *
 * RUN THIS BEFORE ANY AUTH_SECRET ROTATION. Proof captured before capture
 * receipts existed is recognised only by its HMAC-bound blob name
 * (`pharmacy-sop-<uuid>-<mac>.<ext>`), and that MAC is keyed from AUTH_SECRET.
 * Once the secret rotates the MAC no longer verifies, the proof reads as
 * "present, capture not confirmed", and a verifier cannot close the procedure.
 * This script turns every legacy name that verifies under the CURRENT secret
 * into a durable, secret-independent receipt (`source = LEGACY_HMAC_BACKFILL`)
 * in `pharmacy_sop_evidence_captures`.
 *
 * It is manual and never runs automatically (it is not a migration and not
 * wired to any deploy step). It is phased and idempotent:
 *
 *   Phase 1 — inventory (default, dry run). Reads only; every organization's
 *             transaction is rolled back. Prints per-organization counts.
 *   Phase 2 — `--apply`. Writes receipts for VERIFIED rows only. Foreign rows
 *             (not a pharmacy-style name) and unverified rows (pharmacy-style
 *             name whose MAC does not verify) never get a receipt. Re-running
 *             writes nothing new: rows that already hold a receipt are not
 *             candidates, and inserts use ON CONFLICT DO NOTHING.
 *
 * Each organization is handled in its own explicit transaction: BEGIN, then
 * set_config('app.current_organization_id', <org>, true) (forced RLS needs the
 * tenant scope inside the transaction), then COMMIT (apply) or ROLLBACK (dry
 * run). The organization list is read under the platform escape in a separate
 * read-only transaction. The tables are tenant-scoped under forced RLS, so the
 * restricted runtime role is sufficient; no superuser is needed.
 *
 *   tsx --tsconfig scripts/tsconfig.json scripts/pharmacy-sop-legacy-capture-backfill.ts
 *   tsx --tsconfig scripts/tsconfig.json scripts/pharmacy-sop-legacy-capture-backfill.ts --apply
 *   ... --org <organizationId>     (repeatable; limit the run to these organizations)
 *
 * Environment: PHARMACY_SOP_BACKFILL_DATABASE_URL (or DATABASE_URL) and the
 * production AUTH_SECRET currently in force. The secret is only used to
 * verify names in memory; it is never printed or stored.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { classifyPharmacySopEvidenceName } from '../src/lib/pharmacy/sop-evidence-mac';

/** The subset of `pg.Client` this script uses (a test can pass a fake). */
export type BackfillClient = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

export type OrganizationCounts = {
  organizationId: string;
  /** Engine evidence on a pharmacy SOP site with no receipt yet. */
  candidates: number;
  /** Candidates whose legacy name verifies under the current secret. */
  verified: number;
  /** Pharmacy-style names whose MAC does not verify: no receipt, reported. */
  unverified: number;
  /** Not a pharmacy-style name: attached outside the pharmacy workspace. */
  foreign: number;
  /** Receipts actually inserted (0 in a dry run). */
  written: number;
};

type CandidateRow = {
  id: string;
  occurrenceId: string;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
  pharmacyBranchId: string;
};

const CANDIDATES_SQL = `
  SELECT evidence."id",
         evidence."occurrenceId",
         evidence."occurrenceStepId",
         evidence."contentHash",
         evidence."mimeType",
         evidence."uploaderStaffProfileId",
         evidence."storageRef",
         site."pharmacyBranchId"
    FROM "restaurant_sop_evidence" evidence
    JOIN "restaurant_sop_occurrences" occurrence
      ON occurrence."organizationId" = evidence."organizationId"
     AND occurrence."id" = evidence."occurrenceId"
    JOIN "pharmacy_sop_sites" site
      ON site."organizationId" = occurrence."organizationId"
     AND site."sopBranchId" = occurrence."branchId"
   WHERE evidence."organizationId" = $1
     AND NOT EXISTS (
       SELECT 1 FROM "pharmacy_sop_evidence_captures" receipt
        WHERE receipt."organizationId" = evidence."organizationId"
          AND receipt."evidenceId" = evidence."id"
     )
   ORDER BY evidence."createdAt", evidence."id"`;

const INSERT_SQL = `
  INSERT INTO "pharmacy_sop_evidence_captures"
    ("id","organizationId","pharmacyBranchId","occurrenceId","evidenceId","contentHash","source","capturedByStaffProfileId","capturedByUserId")
  VALUES ($1,$2,$3,$4,$5,$6,'LEGACY_HMAC_BACKFILL',$7,NULL)
  ON CONFLICT ("organizationId","evidenceId") DO NOTHING`;

/**
 * Backfill one organization inside a transaction the CALLER owns, with the
 * tenant scope already set. Never commits or rolls back itself.
 */
export async function backfillOrganization(
  client: BackfillClient,
  organizationId: string,
  options: { apply: boolean }
): Promise<OrganizationCounts> {
  const { rows } = await client.query<CandidateRow>(CANDIDATES_SQL, [organizationId]);
  const counts: OrganizationCounts = {
    organizationId,
    candidates: rows.length,
    verified: 0,
    unverified: 0,
    foreign: 0,
    written: 0,
  };
  for (const row of rows) {
    const kind = classifyPharmacySopEvidenceName(row, organizationId);
    if (kind === 'FOREIGN') {
      counts.foreign += 1;
      continue;
    }
    if (kind === 'UNCONFIRMED') {
      counts.unverified += 1;
      continue;
    }
    counts.verified += 1;
    if (!options.apply) continue;
    const inserted = await client.query(INSERT_SQL, [
      `psec_${randomUUID()}`,
      organizationId,
      row.pharmacyBranchId,
      row.occurrenceId,
      row.id,
      row.contentHash,
      // The MAC covers the uploader, so the capturing staff profile is known.
      row.uploaderStaffProfileId,
    ]);
    counts.written += inserted.rowCount ?? 0;
  }
  return counts;
}

async function setScope(client: BackfillClient, organizationId: string | null) {
  await client.query(
    `SELECT set_config('app.is_platform_admin', $1, true),
            set_config('app.current_organization_id', $2, true),
            set_config('app.current_branch_id', '', true)`,
    [organizationId === null ? 'true' : 'false', organizationId ?? '']
  );
}

/** Organizations with at least one pharmacy SOP site, read under the platform escape. */
async function organizationsWithSites(client: BackfillClient): Promise<string[]> {
  await client.query('BEGIN READ ONLY');
  try {
    await setScope(client, null);
    const { rows } = await client.query<{ organizationId: string }>(
      `SELECT DISTINCT "organizationId" FROM "pharmacy_sop_sites" ORDER BY "organizationId"`
    );
    await client.query('COMMIT');
    return rows.map((row) => row.organizationId);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Run the whole backfill: one explicit transaction per organization. */
export async function runLegacyCaptureBackfill(
  client: BackfillClient,
  options: {
    apply: boolean;
    organizationIds?: readonly string[];
    log?: (line: string) => void;
  }
): Promise<OrganizationCounts[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!process.env.AUTH_SECRET?.trim()) {
    throw new Error(
      'AUTH_SECRET is not set. The backfill verifies legacy names with the secret currently in force.'
    );
  }
  const all = await organizationsWithSites(client);
  const wanted = options.organizationIds?.length ? new Set(options.organizationIds) : null;
  const organizations = wanted ? all.filter((id) => wanted.has(id)) : all;
  log(
    `${options.apply ? 'APPLY' : 'DRY RUN (no writes; pass --apply to write)'}: ${organizations.length} organization(s) with pharmacy SOP sites`
  );

  const results: OrganizationCounts[] = [];
  for (const organizationId of organizations) {
    await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    try {
      await setScope(client, organizationId);
      const counts = await backfillOrganization(client, organizationId, { apply: options.apply });
      await client.query(options.apply ? 'COMMIT' : 'ROLLBACK');
      results.push(counts);
      log(
        `${organizationId}: candidates=${counts.candidates} verified=${counts.verified} unverified=${counts.unverified} foreign=${counts.foreign} written=${counts.written}`
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  const total = (key: keyof Omit<OrganizationCounts, 'organizationId'>) =>
    results.reduce((sum, row) => sum + row[key], 0);
  log(
    `TOTAL: candidates=${total('candidates')} verified=${total('verified')} unverified=${total('unverified')} foreign=${total('foreign')} written=${total('written')}`
  );
  if (total('unverified') > 0) {
    log(
      'Unverified rows keep no receipt. If AUTH_SECRET has already rotated, run once more with the previous secret in force, or have a verifier send those procedures back.'
    );
  }
  return results;
}

export function parseArgs(argv: readonly string[]) {
  const organizationIds: string[] = [];
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--org' && argv[index + 1]) organizationIds.push(argv[(index += 1)]!);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, organizationIds };
}

async function main() {
  const databaseUrl = process.env.PHARMACY_SOP_BACKFILL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('PHARMACY_SOP_BACKFILL_DATABASE_URL or DATABASE_URL is required.');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await runLegacyCaptureBackfill(
      client as unknown as BackfillClient,
      parseArgs(process.argv.slice(2))
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Backfill failed.');
    process.exitCode = 1;
  });
}
