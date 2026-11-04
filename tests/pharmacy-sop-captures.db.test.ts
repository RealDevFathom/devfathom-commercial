import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  insertEvidence,
  ownerUrl,
  refused,
  runtimeUrl,
  scopeAs,
  seedSopTenant,
} from './pharmacy-sop-capture-fixtures';

/**
 * DEV-751 — pharmacy SOP capture receipts and branch settings under PostgreSQL.
 *
 * Runs against a migrated database as the restricted runtime role, inside one
 * transaction that is rolled back at the end. Skips when the URLs are absent;
 * the static migration contract always runs.
 */
const RUNTIME_URL = runtimeUrl();
const OWNER_URL = ownerUrl();
const describeIfDatabase = RUNTIME_URL && OWNER_URL ? describe : describe.skip;
const tables = ['pharmacy_sop_evidence_captures', 'pharmacy_sop_site_settings'] as const;
const migration = readFileSync(
  'prisma/migrations/20261104130000_pharmacy_sop_evidence_captures_and_settings/migration.sql',
  'utf8'
);

describe('DEV-751 capture receipt migration contract', () => {
  it('forces tenant/branch RLS on both tables and keeps both append-only', () => {
    for (const table of tables) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      const policies = migration.match(new RegExp(`CREATE POLICY \\w+ ON "${table}"[^\\n]*`, 'g'));
      expect(policies).toHaveLength(2);
      for (const policy of policies ?? []) expect(policy).toMatch(/ FOR (SELECT|INSERT)$/);
    }
  });

  it('keys every cross-table reference by organization', () => {
    for (const reference of [
      'REFERENCES "pharmacy_branches" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_evidence" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_occurrences" ("organizationId", "id")',
      'REFERENCES "restaurant_staff_profiles" ("organizationId", "id")',
    ]) {
      expect(migration).toContain(reference);
    }
  });

  it('backfills nothing and only adds a tenant key to restaurant_sop_evidence', () => {
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/\bUPDATE\s+"/);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
    const altered = [...sql.matchAll(/ALTER TABLE "(?!pharmacy_sop_)([a-z_]+)"([^;]*);/g)];
    expect(altered.map(([, table, rest]) => [table, rest!.replace(/\s+/g, ' ').trim()])).toEqual([
      [
        'restaurant_sop_evidence',
        'ADD CONSTRAINT "restaurant_sop_evidence_organizationId_id_key" UNIQUE ("organizationId", "id")',
      ],
    ]);
  });
});

let runtime: Client;
const run = Math.random().toString(36).slice(2, 10);
const id = (name: string) => `dev751c_${run}_${name}`;
const A = id('org_a');
const B = id('org_b');
const HASH = 'a'.repeat(64);

const captureColumns = `("id","organizationId","pharmacyBranchId","occurrenceId","evidenceId","contentHash","source","capturedByStaffProfileId","capturedByUserId")`;

function capture(
  receiptId: string,
  org: string,
  overrides: Partial<{
    pharmacyBranchId: string;
    occurrenceId: string;
    evidenceId: string;
    contentHash: string;
    source: string;
    capturedByStaffProfileId: string | null;
    capturedByUserId: string | null;
  }> = {}
) {
  const row = {
    pharmacyBranchId: `${org}_pb`,
    occurrenceId: `${org}_occ`,
    evidenceId: `${org}_ev`,
    contentHash: HASH,
    source: 'UPLOAD',
    capturedByStaffProfileId: `${org}_sp` as string | null,
    capturedByUserId: 'user_1' as string | null,
    ...overrides,
  };
  return {
    sql: `INSERT INTO pharmacy_sop_evidence_captures ${captureColumns} VALUES ($1,$2,$3,$4,$5,$6,$7::"PharmacySopCaptureSource",$8,$9)`,
    params: [
      receiptId,
      org,
      row.pharmacyBranchId,
      row.occurrenceId,
      row.evidenceId,
      row.contentHash,
      row.source,
      row.capturedByStaffProfileId,
      row.capturedByUserId,
    ],
  };
}

async function attempt(statement: { sql: string; params: unknown[] }) {
  return refused(runtime, statement.sql, statement.params);
}

describeIfDatabase('DEV-751 capture receipts under PostgreSQL RLS', () => {
  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_URL });
    await runtime.connect();
    await runtime.query('BEGIN');
    await scopeAs(runtime, null);
    for (const org of [A, B]) {
      await seedSopTenant(runtime, org);
      for (const [suffix, occurrence, step] of [
        ['_ev', `${org}_occ`, `${org}_ostep`],
        ['_ev2', `${org}_occ`, `${org}_ostep`],
        ['_ev3', `${org}_occ`, `${org}_ostep`],
        ['_ev_unbound', `${org}_occ_unbound`, `${org}_ostep_unbound`],
      ] as const) {
        await insertEvidence(runtime, {
          id: `${org}${suffix}`,
          organizationId: org,
          occurrenceId: occurrence,
          occurrenceStepId: step,
          contentHash: HASH,
          mimeType: `image/png; evidence=photo${suffix}`,
          uploaderStaffProfileId: `${org}_sp`,
          storageRef: `/api/files/pharmacy-sop-${suffix}.png`,
        });
      }
    }
  });

  afterAll(async () => {
    await runtime?.query('ROLLBACK').catch(() => undefined);
    await runtime?.end();
  });

  it('runs as a restricted role, never SUPERUSER or BYPASSRLS', async () => {
    expect(OWNER_URL).not.toBe(RUNTIME_URL);
    const result = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('creates both tables with RLS enabled and forced, and SELECT + INSERT policies only', async () => {
    const result = await runtime.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY relname`,
      [tables]
    );
    expect(result.rows).toEqual([
      { relname: tables[0], relrowsecurity: true, relforcerowsecurity: true },
      { relname: tables[1], relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await runtime.query<{ tablename: string; cmd: string; expr: string }>(
      `SELECT tablename, cmd, COALESCE(qual, with_check) AS expr FROM pg_policies
        WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [tables]
    );
    expect(policies.rows.map((row) => [row.tablename, row.cmd])).toEqual([
      [tables[0], 'INSERT'],
      [tables[0], 'SELECT'],
      [tables[1], 'INSERT'],
      [tables[1], 'SELECT'],
    ]);
    for (const policy of policies.rows) {
      expect(policy.expr).toContain('app.current_organization_id');
      expect(policy.expr).toContain('app.current_branch_id');
      expect(policy.expr).toContain('app.is_platform_admin');
    }
  });

  it('accepts a receipt that describes its evidence row and keeps it unique per evidence', async () => {
    await scopeAs(runtime, A);
    expect(await attempt(capture(id('ok'), A))).toBe('ACCEPTED');
    await runtime.query(capture(id('ok'), A).sql, capture(id('ok'), A).params);
    expect(await attempt(capture(id('dup'), A))).toBe('23505');
    // ON CONFLICT DO NOTHING (Prisma skipDuplicates) is how a retry stays one receipt.
    const healed = await runtime.query(
      `${capture(id('dup'), A).sql} ON CONFLICT ("organizationId","evidenceId") DO NOTHING`,
      capture(id('dup'), A).params
    );
    expect(healed.rowCount).toBe(0);
    // The organization defaults from the tenant GUC when omitted.
    const defaulted = await runtime.query<{ organizationId: string }>(
      `INSERT INTO pharmacy_sop_evidence_captures ("id","pharmacyBranchId","occurrenceId","evidenceId","contentHash","source","capturedByStaffProfileId","capturedByUserId")
       VALUES ($1,$2,$3,$4,$5,'UPLOAD',$6,'user_1') RETURNING "organizationId"`,
      [id('defaulted'), `${A}_pb`, `${A}_occ`, `${A}_ev2`, HASH, `${A}_sp`]
    );
    expect(defaulted.rows).toEqual([{ organizationId: A }]);
  });

  it('refuses a receipt that does not match its evidence, occurrence, hash, uploader or site', async () => {
    await scopeAs(runtime, A);
    const cases: Array<[string, Parameters<typeof capture>[2], RegExp]> = [
      ['missing evidence', { evidenceId: `${A}_ev_none` }, /^(23514|23503)$/],
      ['other occurrence', { occurrenceId: `${A}_occ_unbound` }, /^23514$/],
      ['other hash', { contentHash: 'b'.repeat(64) }, /^23514$/],
      ['other uploader', { capturedByStaffProfileId: `${A}_sp2` }, /^23514$/],
      [
        'backfill naming another uploader',
        { source: 'LEGACY_HMAC_BACKFILL', capturedByStaffProfileId: `${A}_sp2` },
        /^23514$/,
      ],
      ['upload without a staff profile', { capturedByStaffProfileId: null }, /^23514$/],
      ['upload without a user', { capturedByUserId: null }, /^23514$/],
      ['branch without a site', { pharmacyBranchId: `${A}_pb2` }, /^23514$/],
      [
        'occurrence outside the site',
        {
          evidenceId: `${A}_ev_unbound`,
          occurrenceId: `${A}_occ_unbound`,
        },
        /^23514$/,
      ],
      ['blank user', { capturedByUserId: '  ' }, /^23514$/],
    ];
    for (const [label, overrides, code] of cases) {
      expect([label, await attempt(capture(id(`bad_${label}`), A, overrides))]).toEqual([
        label,
        expect.stringMatching(code),
      ]);
    }
    expect(await attempt(capture('  ', A, { evidenceId: `${A}_ev2` }))).toBe('23514');
  });

  it('accepts a backfill receipt with no signed-in user', async () => {
    await scopeAs(runtime, A);
    expect(
      await attempt(
        capture(id('backfill'), A, {
          evidenceId: `${A}_ev3`,
          source: 'LEGACY_HMAC_BACKFILL',
          capturedByUserId: null,
        })
      )
    ).toBe('ACCEPTED');
  });

  it('refuses cross-tenant receipts, explicit or by reference', async () => {
    await scopeAs(runtime, A);
    // Explicitly naming tenant B: the trigger cannot see B's rows, the policy refuses.
    expect(await attempt(capture(id('cross'), B))).toMatch(/^(42501|23514)$/);
    // Tenant A's org pointing at B's evidence, occurrence, branch or staff.
    for (const overrides of [
      { evidenceId: `${B}_ev` },
      { occurrenceId: `${B}_occ` },
      { pharmacyBranchId: `${B}_pb` },
      { capturedByStaffProfileId: `${B}_sp` },
    ]) {
      expect(await attempt(capture(id('foreign_ref'), A, overrides))).toMatch(/^(23503|23514)$/);
    }
  });

  it('hides another tenant’s receipts and settings, and scopes by branch', async () => {
    await scopeAs(runtime, B);
    await runtime.query(capture(id('b_ok'), B).sql, capture(id('b_ok'), B).params);
    await runtime.query(
      `INSERT INTO pharmacy_sop_site_settings ("id","organizationId","pharmacyBranchId","autoScheduleEnabled","changedByUserId")
       VALUES ($1,$2,$3,true,'user_b')`,
      [id('b_setting'), B, `${B}_pb`]
    );
    await scopeAs(runtime, A);
    const receipts = await runtime.query(
      `SELECT id FROM pharmacy_sop_evidence_captures WHERE id = ANY($1::text[])`,
      [[id('ok'), id('b_ok')]]
    );
    expect(receipts.rows).toEqual([{ id: id('ok') }]);
    const settings = await runtime.query(
      `SELECT id FROM pharmacy_sop_site_settings WHERE id = $1`,
      [id('b_setting')]
    );
    expect(settings.rowCount).toBe(0);
    await scopeAs(runtime, A, `${A}_pb2`);
    const scoped = await runtime.query(
      `SELECT id FROM pharmacy_sop_evidence_captures WHERE id = $1`,
      [id('ok')]
    );
    expect(scoped.rowCount).toBe(0);
  });

  it('keeps receipts and settings append-only, even under the platform escape', async () => {
    await scopeAs(runtime, A);
    await runtime.query(
      `INSERT INTO pharmacy_sop_site_settings ("id","organizationId","pharmacyBranchId","autoScheduleEnabled","changedByUserId","reason")
       VALUES ($1,$2,$3,false,'user_1','Opt out')`,
      [id('setting'), A, `${A}_pb`]
    );
    for (const scope of [A, null]) {
      await scopeAs(runtime, scope);
      for (const sql of [
        `UPDATE pharmacy_sop_evidence_captures SET "contentHash" = 'x' WHERE id = $1`,
        `DELETE FROM pharmacy_sop_evidence_captures WHERE id = $1`,
      ]) {
        expect((await runtime.query(sql, [id('ok')])).rowCount).toBe(0);
      }
      for (const sql of [
        `UPDATE pharmacy_sop_site_settings SET "autoScheduleEnabled" = true WHERE id = $1`,
        `DELETE FROM pharmacy_sop_site_settings WHERE id = $1`,
      ]) {
        expect((await runtime.query(sql, [id('setting')])).rowCount).toBe(0);
      }
    }
    await scopeAs(runtime, A);
    const receipt = await runtime.query(
      `SELECT "contentHash" FROM pharmacy_sop_evidence_captures WHERE id = $1`,
      [id('ok')]
    );
    expect(receipt.rows).toEqual([{ contentHash: HASH }]);
    const setting = await runtime.query(
      `SELECT "autoScheduleEnabled" FROM pharmacy_sop_site_settings WHERE id = $1`,
      [id('setting')]
    );
    expect(setting.rows).toEqual([{ autoScheduleEnabled: false }]);
    // A receipt pins its evidence row: the composite key refuses its removal.
    const keys = await runtime.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'pharmacy_sop_evidence_captures'::regclass AND contype = 'f'
        ORDER BY conname`
    );
    expect(keys.rows).toEqual([
      { conname: 'pharmacy_sop_evidence_captures_evidence_fkey', confdeltype: 'r' },
      { conname: 'pharmacy_sop_evidence_captures_occurrence_fkey', confdeltype: 'r' },
      {
        conname: 'pharmacy_sop_evidence_captures_pharmacy_branch_fkey',
        confdeltype: 'r',
      },
      { conname: 'pharmacy_sop_evidence_captures_staff_fkey', confdeltype: 'r' },
    ]);
  });

  it('checks the settings shape', async () => {
    await scopeAs(runtime, A);
    const insert = (values: unknown[]) =>
      refused(
        runtime,
        `INSERT INTO pharmacy_sop_site_settings ("id","organizationId","pharmacyBranchId","autoScheduleEnabled","changedByUserId","reason")
         VALUES ($1,$2,$3,$4,$5,$6)`,
        values
      );
    expect(await insert([id('s_ok'), A, `${A}_pb`, true, 'user_1', 'x'.repeat(500)])).toBe(
      'ACCEPTED'
    );
    expect(await insert([id('s_long'), A, `${A}_pb`, true, 'user_1', 'x'.repeat(501)])).toBe(
      '23514'
    );
    expect(await insert([id('s_blank'), A, `${A}_pb`, true, ' ', null])).toBe('23514');
    expect(await insert([id('s_null'), A, `${A}_pb`, null, 'user_1', null])).toBe('23502');
    expect(await insert([id('s_cross'), A, `${B}_pb`, true, 'user_1', null])).toBe('23503');
  });
});
