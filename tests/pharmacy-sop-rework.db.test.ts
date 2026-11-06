// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ownerUrl,
  refused,
  runtimeUrl,
  scopeAs,
  seedSopTenant,
} from './pharmacy-sop-capture-fixtures';

vi.mock('server-only', () => ({}));

/**
 * DEV-751 — pharmacy SOP rework notes under PostgreSQL.
 *
 * Runs against a migrated database as the restricted runtime role, inside one
 * transaction that is rolled back at the end, so the append-only rows seeded
 * here never outlive the suite. Skips when the URLs are absent; the static
 * migration contract always runs.
 */
const RUNTIME_URL = runtimeUrl();
const OWNER_URL = ownerUrl();
const describeIfDatabase = RUNTIME_URL && OWNER_URL ? describe : describe.skip;
const TABLE = 'pharmacy_sop_rework_notes';
const migration = readFileSync(
  'prisma/migrations/20261104140000_pharmacy_sop_rework_notes/migration.sql',
  'utf8'
);

describe('DEV-751 rework note migration contract', () => {
  it('forces tenant/branch RLS and keeps the table append-only', () => {
    expect(migration).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    const policies = migration.match(new RegExp(`CREATE POLICY \\w+ ON "${TABLE}"[^\\n]*`, 'g'));
    expect(policies).toHaveLength(2);
    for (const policy of policies ?? []) expect(policy).toMatch(/ FOR (SELECT|INSERT)$/);
  });

  it('keys cross-table references by organization; the send-back is org-checked by the trigger', () => {
    // restaurant_sop_verifications has no tenant composite key and is not
    // altered: the note references it by primary key and the trigger refuses
    // any verification outside the note's organization.
    expect(migration).toContain('REFERENCES "restaurant_sop_verifications" ("id")');
    expect(migration).toMatch(
      /FROM "restaurant_sop_verifications" verification\s+WHERE verification\."organizationId" = NEW\."organizationId"/
    );
    for (const reference of [
      'REFERENCES "pharmacy_branches" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_occurrences" ("organizationId", "id")',
      'REFERENCES "restaurant_sop_occurrence_steps" ("organizationId", "id")',
      'REFERENCES "restaurant_staff_profiles" ("organizationId", "id")',
    ]) {
      expect(migration).toContain(reference);
    }
  });

  it('backfills nothing and alters no existing table', () => {
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/\bUPDATE\s+"/);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
    const altered = [...sql.matchAll(/ALTER TABLE "(?!pharmacy_sop_)([a-z_]+)"([^;]*);/g)];
    expect(altered.map(([, table]) => table)).toEqual([]);
  });
});

let runtime: Client;
const run = Math.random().toString(36).slice(2, 10);
const id = (name: string) => `dev751r_${run}_${name}`;
const A = id('org_a');
const B = id('org_b');

const columns = `("id","organizationId","pharmacyBranchId","occurrenceId","occurrenceStepId","rejectionVerificationId","note","authorStaffProfileId","authorUserId")`;

type NoteRow = {
  pharmacyBranchId: string;
  occurrenceId: string;
  occurrenceStepId: string | null;
  rejectionVerificationId: string;
  note: string;
  authorStaffProfileId: string;
  authorUserId: string;
};

function note(noteId: string, org: string, overrides: Partial<NoteRow> = {}) {
  const row: NoteRow = {
    pharmacyBranchId: `${org}_pb`,
    occurrenceId: `${org}_occ`,
    occurrenceStepId: `${org}_ostep`,
    rejectionVerificationId: `${org}_rej_new`,
    note: 'Re-took the fridge reading after the door seal was fixed.',
    authorStaffProfileId: `${org}_sp`,
    authorUserId: 'user_1',
    ...overrides,
  };
  return {
    sql: `INSERT INTO ${TABLE} ${columns} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    params: [
      noteId,
      org,
      row.pharmacyBranchId,
      row.occurrenceId,
      row.occurrenceStepId,
      row.rejectionVerificationId,
      row.note,
      row.authorStaffProfileId,
      row.authorUserId,
    ],
  };
}

const attempt = (statement: { sql: string; params: unknown[] }) =>
  refused(runtime, statement.sql, statement.params);

/** Insert one verification row exactly as given (platform scope). */
async function verification(
  verificationId: string,
  org: string,
  occurrenceId: string,
  action: 'VERIFY' | 'REJECT' | 'WAIVE',
  createdAt: string
) {
  await runtime.query(
    `INSERT INTO "restaurant_sop_verifications" ("id","organizationId","occurrenceId","action","actorStaffProfileId","reason","createdAt")
     VALUES ($1,$2,$3,$4::"RestaurantSopVerificationAction",$5,$6,$7)`,
    [verificationId, org, occurrenceId, action, `${org}_sp2`, 'Sent back for QA', createdAt]
  );
}

describeIfDatabase('DEV-751 rework notes under PostgreSQL RLS', () => {
  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_URL });
    await runtime.connect();
    await runtime.query('BEGIN');
    await scopeAs(runtime, null);
    for (const org of [A, B]) {
      await seedSopTenant(runtime, org);
      // Both occurrences are back in the owner's hands for rework.
      await runtime.query(
        `UPDATE "restaurant_sop_occurrences" SET "status" = 'IN_PROGRESS', "assignedStaffProfileId" = $2
          WHERE "organizationId" = $1`,
        [org, `${org}_sp`]
      );
      await verification(`${org}_verified_first`, org, `${org}_occ`, 'VERIFY', '2026-11-02 03:30');
      await verification(`${org}_rej_old`, org, `${org}_occ`, 'REJECT', '2026-11-02 04:00');
      await verification(`${org}_rej_new`, org, `${org}_occ`, 'REJECT', '2026-11-02 06:00');
      await verification(
        `${org}_rej_unbound`,
        org,
        `${org}_occ_unbound`,
        'REJECT',
        '2026-11-02 06:00'
      );
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

  it('creates the table with RLS enabled and forced, and SELECT + INSERT policies only', async () => {
    const result = await runtime.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
      [TABLE]
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await runtime.query<{ cmd: string; expr: string }>(
      `SELECT cmd, COALESCE(qual, with_check) AS expr FROM pg_policies WHERE tablename = $1 ORDER BY cmd`,
      [TABLE]
    );
    expect(policies.rows.map((row) => row.cmd)).toEqual(['INSERT', 'SELECT']);
    for (const policy of policies.rows) {
      expect(policy.expr).toContain('app.current_organization_id');
      expect(policy.expr).toContain('app.current_branch_id');
      expect(policy.expr).toContain('app.is_platform_admin');
    }
  });

  it('accepts a note answering the latest send-back, with or without a step', async () => {
    await scopeAs(runtime, A);
    await runtime.query(note(id('ok'), A).sql, note(id('ok'), A).params);
    expect(await attempt(note(id('ok_no_step'), A, { occurrenceStepId: null }))).toBe('ACCEPTED');
    // The organization defaults from the tenant GUC when omitted.
    const defaulted = await runtime.query<{ organizationId: string }>(
      `INSERT INTO ${TABLE} ("id","pharmacyBranchId","occurrenceId","rejectionVerificationId","note","authorStaffProfileId","authorUserId")
       VALUES ($1,$2,$3,$4,'Second note','${A}_sp','user_1') RETURNING "organizationId"`,
      [id('defaulted'), `${A}_pb`, `${A}_occ`, `${A}_rej_new`]
    );
    expect(defaulted.rows).toEqual([{ organizationId: A }]);
  });

  it('refuses a note that does not answer the latest send-back of its own occurrence', async () => {
    await scopeAs(runtime, A);
    const cases: Array<[string, Partial<NoteRow>, RegExp]> = [
      [
        'an older send-back (not the latest review)',
        { rejectionVerificationId: `${A}_rej_old` },
        /^23514$/,
      ],
      [
        'a review that is not a send-back',
        { rejectionVerificationId: `${A}_verified_first` },
        /^23514$/,
      ],
      [
        'another occurrence’s send-back',
        { rejectionVerificationId: `${A}_rej_unbound` },
        /^23514$/,
      ],
      ['a missing send-back', { rejectionVerificationId: `${A}_rej_none` }, /^(23514|23503)$/],
      ['a step of another occurrence', { occurrenceStepId: `${A}_ostep_unbound` }, /^23514$/],
      ['an author who does not own the work', { authorStaffProfileId: `${A}_sp2` }, /^23514$/],
      [
        'an occurrence outside the pharmacy SOP site',
        {
          occurrenceId: `${A}_occ_unbound`,
          occurrenceStepId: `${A}_ostep_unbound`,
          rejectionVerificationId: `${A}_rej_unbound`,
        },
        /^23514$/,
      ],
      ['a branch without a site', { pharmacyBranchId: `${A}_pb2` }, /^23514$/],
      ['a blank note', { note: '   ' }, /^23514$/],
      ['a note over 2000 characters', { note: 'x'.repeat(2001) }, /^23514$/],
      ['a blank author user', { authorUserId: ' ' }, /^23514$/],
    ];
    for (const [label, overrides, code] of cases) {
      expect([label, await attempt(note(id(`bad_${label}`), A, overrides))]).toEqual([
        label,
        expect.stringMatching(code),
      ]);
    }
    expect(await attempt(note(id('max'), A, { note: 'x'.repeat(2000) }))).toBe('ACCEPTED');
    expect(await attempt(note('  ', A))).toBe('23514');
  });

  it('refuses a note once the procedure is no longer being reworked', async () => {
    await scopeAs(runtime, A);
    for (const status of ['SUBMITTED', 'REJECTED', 'VERIFIED']) {
      await runtime.query('SAVEPOINT status_case');
      try {
        await runtime.query(
          `UPDATE "restaurant_sop_occurrences" SET "status" = $2::"RestaurantSopOccurrenceStatus" WHERE "id" = $1`,
          [`${A}_occ`, status]
        );
        expect([status, await attempt(note(id(`status_${status}`), A))]).toEqual([status, '23514']);
      } finally {
        await runtime.query('ROLLBACK TO SAVEPOINT status_case');
      }
    }
  });

  it('a later review supersedes the send-back a note may answer', async () => {
    await scopeAs(runtime, null);
    await runtime.query('SAVEPOINT later_review');
    try {
      await verification(`${A}_rej_newest`, A, `${A}_occ`, 'REJECT', '2026-11-02 07:00');
      await scopeAs(runtime, A);
      expect(await attempt(note(id('superseded'), A))).toBe('23514');
      expect(
        await attempt(note(id('newest'), A, { rejectionVerificationId: `${A}_rej_newest` }))
      ).toBe('ACCEPTED');
    } finally {
      await runtime.query('ROLLBACK TO SAVEPOINT later_review');
    }
  });

  it('refuses cross-tenant notes, explicit or by reference', async () => {
    await scopeAs(runtime, A);
    // Explicitly naming tenant B: the trigger cannot see B's rows, the policy refuses.
    expect(await attempt(note(id('cross'), B))).toMatch(/^(42501|23514)$/);
    // Tenant A's org pointing at B's send-back, occurrence, step, branch or staff.
    for (const overrides of [
      { rejectionVerificationId: `${B}_rej_new` },
      { occurrenceId: `${B}_occ` },
      { occurrenceStepId: `${B}_ostep` },
      { pharmacyBranchId: `${B}_pb` },
      { authorStaffProfileId: `${B}_sp` },
    ]) {
      expect([overrides, await attempt(note(id('foreign_ref'), A, overrides))]).toEqual([
        overrides,
        expect.stringMatching(/^(23503|23514)$/),
      ]);
    }
  });

  it('hides another tenant’s notes and scopes by branch', async () => {
    await scopeAs(runtime, B);
    await runtime.query(note(id('b_ok'), B).sql, note(id('b_ok'), B).params);
    await scopeAs(runtime, A);
    const visible = await runtime.query(`SELECT id FROM ${TABLE} WHERE id = ANY($1::text[])`, [
      [id('ok'), id('b_ok')],
    ]);
    expect(visible.rows).toEqual([{ id: id('ok') }]);
    await scopeAs(runtime, A, `${A}_pb2`);
    const scoped = await runtime.query(`SELECT id FROM ${TABLE} WHERE id = $1`, [id('ok')]);
    expect(scoped.rowCount).toBe(0);
  });

  it('keeps notes append-only, even under the platform escape', async () => {
    for (const scope of [A, null]) {
      await scopeAs(runtime, scope);
      for (const sql of [
        `UPDATE ${TABLE} SET "note" = 'rewritten' WHERE id = $1`,
        `DELETE FROM ${TABLE} WHERE id = $1`,
      ]) {
        expect((await runtime.query(sql, [id('ok')])).rowCount).toBe(0);
      }
    }
    await scopeAs(runtime, A);
    const kept = await runtime.query(`SELECT "note" FROM ${TABLE} WHERE id = $1`, [id('ok')]);
    expect(kept.rows).toEqual([
      { note: 'Re-took the fridge reading after the door seal was fixed.' },
    ]);
    // A note pins its occurrence, step, send-back, author and branch.
    const keys = await runtime.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = '${TABLE}'::regclass AND contype = 'f' ORDER BY conname`
    );
    expect(keys.rows).toEqual([
      { conname: 'pharmacy_sop_rework_notes_author_fkey', confdeltype: 'r' },
      { conname: 'pharmacy_sop_rework_notes_occurrence_fkey', confdeltype: 'r' },
      {
        conname: 'pharmacy_sop_rework_notes_organizationId_pharmacyBranchId_fkey',
        confdeltype: 'r',
      },
      { conname: 'pharmacy_sop_rework_notes_rejection_fkey', confdeltype: 'r' },
      { conname: 'pharmacy_sop_rework_notes_step_fkey', confdeltype: 'r' },
    ]);
  });

  it('exports notes in the inspection pack SOP section by display name', async () => {
    const { SOP_OCCURRENCE_INSPECTION_QUERY } = await import('@/lib/pharmacy/inspection-pack');
    await scopeAs(runtime, A);
    const { rows } = await runtime.query<{ record: Record<string, unknown> }>(
      SOP_OCCURRENCE_INSPECTION_QUERY,
      [new Date('2026-11-01T00:00:00Z'), new Date('2026-11-03T00:00:00Z'), `${A}_pb`]
    );
    expect(rows).toHaveLength(1);
    const notes = rows[0]!.record.reworkNotes as Array<Record<string, unknown>>;
    // The two notes kept (attempts roll back to their savepoint).
    expect(notes).toHaveLength(2);
    expect(notes).toContainEqual(
      expect.objectContaining({
        stepOrder: 1,
        note: 'Re-took the fridge reading after the door seal was fixed.',
        author: 'Staff',
        sentBackAt: expect.stringMatching(/^2026-11-02T06:00:00/),
      })
    );
    expect(notes).toContainEqual(expect.objectContaining({ stepOrder: null, author: 'Staff' }));
    expect(JSON.stringify(notes)).not.toContain(`${A}_sp`);
    // Another tenant's notes never appear in this branch's export.
    expect(JSON.stringify(rows)).not.toContain(B);
  });
});
