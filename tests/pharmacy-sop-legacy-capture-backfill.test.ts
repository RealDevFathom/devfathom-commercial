import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  backfillOrganization,
  parseArgs,
  runLegacyCaptureBackfill,
  type BackfillClient,
} from '../scripts/pharmacy-sop-legacy-capture-backfill';
import { pharmacySopEvidenceFilename } from '@/lib/pharmacy/sop-evidence-mac';
import {
  insertEvidence,
  ownerUrl,
  runtimeUrl,
  scopeAs,
  seedSopTenant,
  type SeedEvidence,
} from './pharmacy-sop-capture-fixtures';

/**
 * DEV-751 — the manual legacy capture-receipt backfill. The transaction
 * choreography runs against a recording fake; the classification and the
 * receipt writes run against PostgreSQL as the restricted runtime role, inside
 * one transaction that is rolled back (skipped without database URLs).
 */
const ORIGINAL_SECRET = process.env.AUTH_SECRET;
const CURRENT_SECRET = 'pharmacy-sop-backfill-fixture-current';
const OLD_SECRET = 'pharmacy-sop-backfill-fixture-old';

afterAll(() => {
  process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

beforeEach(() => {
  process.env.AUTH_SECRET = CURRENT_SECRET;
});

/** Records every statement; answers the organization list and candidate reads. */
function recordingClient(candidates: Array<Record<string, unknown>> = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client: BackfillClient = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT DISTINCT "organizationId"')) {
        return { rows: [{ organizationId: 'org_1' }, { organizationId: 'org_2' }], rowCount: 2 };
      }
      if (sql.includes('FROM "restaurant_sop_evidence" evidence')) {
        return { rows: candidates, rowCount: candidates.length } as never;
      }
      return { rows: [], rowCount: sql.startsWith('\n  INSERT') ? 1 : 0 };
    },
  };
  return { client, statements };
}

function legacyCandidate(organizationId: string, secret: string) {
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = secret;
  const identity = {
    organizationId,
    occurrenceId: 'occ_1',
    occurrenceStepId: 'ostep_1',
    contentHash: 'a'.repeat(64),
    mimeType: 'image/png; evidence=photo',
    uploaderStaffProfileId: 'staff_1',
  };
  const name = pharmacySopEvidenceFilename(identity, 'png');
  process.env.AUTH_SECRET = previous;
  const { organizationId: _org, ...row } = identity;
  return { id: `ev_${secret}`, ...row, storageRef: `/api/files/${name}`, pharmacyBranchId: 'pb_1' };
}

describe('legacy capture backfill choreography', () => {
  it('dry run: one read-only transaction per organization, set_config inside it, always rolled back', async () => {
    const { client, statements } = recordingClient([legacyCandidate('org_1', CURRENT_SECRET)]);
    const lines: string[] = [];
    await runLegacyCaptureBackfill(client, { apply: false, log: (line) => lines.push(line) });
    const control = statements
      .map((statement) => statement.sql)
      .filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('set_config'))
      .map((sql) => (sql.includes('set_config') ? 'set_config' : sql));
    expect(control).toEqual([
      'BEGIN READ ONLY',
      'set_config',
      'COMMIT',
      'BEGIN READ ONLY',
      'set_config',
      'ROLLBACK',
      'BEGIN READ ONLY',
      'set_config',
      'ROLLBACK',
    ]);
    const scopes = statements.filter((statement) => statement.sql.includes('set_config'));
    expect(scopes.map((statement) => statement.params)).toEqual([
      ['true', ''],
      ['false', 'org_1'],
      ['false', 'org_2'],
    ]);
    expect(statements.some((statement) => statement.sql.startsWith('INSERT'))).toBe(false);
    expect(lines[0]).toContain('DRY RUN');
    expect(lines).toContain('org_1: candidates=1 verified=1 unverified=0 foreign=0 written=0');
    expect(lines.join('\n')).not.toContain(CURRENT_SECRET);
  });

  it('apply: commits per organization and limits the run to --org', async () => {
    const { client, statements } = recordingClient([]);
    await runLegacyCaptureBackfill(client, {
      apply: true,
      organizationIds: ['org_2'],
      log: () => undefined,
    });
    const control = statements
      .map((statement) => statement.sql)
      .filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql));
    expect(control).toEqual(['BEGIN READ ONLY', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(statements.some((statement) => statement.params.includes('org_1'))).toBe(false);
  });

  it('rolls an organization back and stops when it fails', async () => {
    const { client, statements } = recordingClient();
    const failing: BackfillClient = {
      async query(sql, params) {
        if (sql.includes('FROM "restaurant_sop_evidence" evidence')) throw new Error('boom');
        return client.query(sql, params);
      },
    };
    await expect(
      runLegacyCaptureBackfill(failing, { apply: true, log: () => undefined })
    ).rejects.toThrow('boom');
    expect(statements.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('refuses to run without the current AUTH_SECRET', async () => {
    delete process.env.AUTH_SECRET;
    const { client, statements } = recordingClient();
    await expect(runLegacyCaptureBackfill(client, { apply: true })).rejects.toThrow(/AUTH_SECRET/);
    expect(statements).toEqual([]);
  });

  it('parses only --apply and --org, dry run by default', () => {
    expect(parseArgs([])).toEqual({ apply: false, organizationIds: [] });
    expect(parseArgs(['--apply', '--org', 'a', '--org', 'b'])).toEqual({
      apply: true,
      organizationIds: ['a', 'b'],
    });
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument/);
  });
});

const RUNTIME_URL = runtimeUrl();
const describeIfDatabase = RUNTIME_URL && ownerUrl() ? describe : describe.skip;

describeIfDatabase('legacy capture backfill against PostgreSQL', () => {
  let runtime: Client;
  const run = Math.random().toString(36).slice(2, 10);
  const org = `dev751b_${run}_org`;
  const other = `dev751b_${run}_other`;

  function minted(id: string, secret: string, overrides: Partial<SeedEvidence> = {}): SeedEvidence {
    const row = {
      id,
      organizationId: org,
      occurrenceId: `${org}_occ`,
      occurrenceStepId: `${org}_ostep`,
      contentHash: id
        .replace(/[^a-f0-9]/g, '')
        .padEnd(64, '0')
        .slice(0, 64),
      mimeType: `image/png; evidence=photo; id=${id}`,
      uploaderStaffProfileId: `${org}_sp`,
      ...overrides,
    };
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = secret;
    const name = pharmacySopEvidenceFilename(row, 'png');
    process.env.AUTH_SECRET = previous;
    return { ...row, storageRef: `/api/files/${name}` };
  }

  async function receipts() {
    const { rows } = await runtime.query<{ evidenceId: string; source: string; staff: string }>(
      `SELECT "evidenceId", "source"::text AS source, "capturedByStaffProfileId" AS staff
         FROM pharmacy_sop_evidence_captures WHERE "organizationId" = $1 ORDER BY "evidenceId"`,
      [org]
    );
    return rows;
  }

  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_URL });
    await runtime.connect();
    await runtime.query('BEGIN');
    await scopeAs(runtime, null);
    await seedSopTenant(runtime, org);
    await seedSopTenant(runtime, other);
    process.env.AUTH_SECRET = CURRENT_SECRET;
    const rows = [
      minted('ev_a_verified', CURRENT_SECRET),
      minted('ev_b_verified_signature', CURRENT_SECRET, {
        mimeType: 'image/png; evidence=signature',
        occurrenceStepId: null,
      }),
      minted('ev_c_rotated', OLD_SECRET),
      { ...minted('ev_d_foreign', CURRENT_SECRET), storageRef: '/api/files/sop-restaurant.png' },
      // A copied pharmacy name on a forged uploader does not verify.
      { ...minted('ev_e_copied', CURRENT_SECRET), uploaderStaffProfileId: `${org}_sp2` },
      // Not on a pharmacy SOP site: never a candidate.
      minted('ev_f_unbound', CURRENT_SECRET, {
        occurrenceId: `${org}_occ_unbound`,
        occurrenceStepId: `${org}_ostep_unbound`,
      }),
      minted('ev_g_receipted', CURRENT_SECRET),
    ];
    for (const row of rows) await insertEvidence(runtime, row);
    // Another tenant's verified legacy row stays out of this organization's run.
    await insertEvidence(
      runtime,
      minted('ev_other', CURRENT_SECRET, {
        organizationId: other,
        occurrenceId: `${other}_occ`,
        occurrenceStepId: `${other}_ostep`,
        uploaderStaffProfileId: `${other}_sp`,
      })
    );
    await scopeAs(runtime, org);
    await runtime.query(
      `INSERT INTO pharmacy_sop_evidence_captures ("id","organizationId","pharmacyBranchId","occurrenceId","evidenceId","contentHash","source","capturedByStaffProfileId","capturedByUserId")
       SELECT 'psec_seed', $1, $2, "occurrenceId", "id", "contentHash", 'UPLOAD', "uploaderStaffProfileId", 'user_seed'
         FROM restaurant_sop_evidence WHERE id = 'ev_g_receipted'`,
      [org, `${org}_pb`]
    );
  });

  afterAll(async () => {
    await runtime?.query('ROLLBACK').catch(() => undefined);
    await runtime?.end();
  });

  it('dry run counts every class and writes nothing', async () => {
    await scopeAs(runtime, org);
    const counts = await backfillOrganization(runtime as never, org, { apply: false });
    expect(counts).toEqual({
      organizationId: org,
      candidates: 5,
      verified: 2,
      unverified: 2,
      foreign: 1,
      written: 0,
    });
    expect(await receipts()).toEqual([
      { evidenceId: 'ev_g_receipted', source: 'UPLOAD', staff: `${org}_sp` },
    ]);
  });

  it('apply writes LEGACY_HMAC_BACKFILL receipts for verified rows only', async () => {
    await scopeAs(runtime, org);
    const counts = await backfillOrganization(runtime as never, org, { apply: true });
    expect(counts).toMatchObject({ candidates: 5, verified: 2, written: 2 });
    expect(await receipts()).toEqual([
      { evidenceId: 'ev_a_verified', source: 'LEGACY_HMAC_BACKFILL', staff: `${org}_sp` },
      { evidenceId: 'ev_b_verified_signature', source: 'LEGACY_HMAC_BACKFILL', staff: `${org}_sp` },
      { evidenceId: 'ev_g_receipted', source: 'UPLOAD', staff: `${org}_sp` },
    ]);
    const byUser = await runtime.query(
      `SELECT count(*)::int AS n FROM pharmacy_sop_evidence_captures
        WHERE "organizationId" = $1 AND "source" = 'LEGACY_HMAC_BACKFILL' AND "capturedByUserId" IS NULL`,
      [org]
    );
    expect(byUser.rows).toEqual([{ n: 2 }]);
  });

  it('is idempotent: a second apply writes nothing and skips foreign and unverified rows again', async () => {
    await scopeAs(runtime, org);
    const counts = await backfillOrganization(runtime as never, org, { apply: true });
    expect(counts).toEqual({
      organizationId: org,
      candidates: 3,
      verified: 0,
      unverified: 2,
      foreign: 1,
      written: 0,
    });
    expect((await receipts()).map((row) => row.evidenceId)).toEqual([
      'ev_a_verified',
      'ev_b_verified_signature',
      'ev_g_receipted',
    ]);
  });

  it('never reaches another tenant', async () => {
    await scopeAs(runtime, other);
    const own = await runtime.query(
      `SELECT count(*)::int AS n FROM pharmacy_sop_evidence_captures WHERE "organizationId" = $1`,
      [other]
    );
    expect(own.rows).toEqual([{ n: 0 }]);
    // Under tenant A's scope the other tenant's evidence is invisible to the run.
    await scopeAs(runtime, org);
    const counts = await backfillOrganization(runtime as never, other, { apply: true });
    expect(counts.candidates).toBe(0);
  });
});
