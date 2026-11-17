import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * DEV-66: runs the forced RLS SELECT and INSERT policies on
 * pharmacy_competitor_price_observations against a real database, as the restricted
 * runtime role, with two organizations and two branches in one of them.
 *
 * Requires a disposable, migrated database:
 *   DEV66_TEST_RUNTIME_DATABASE_URL   restricted LOGIN role (NOSUPERUSER, NOBYPASSRLS)
 *   DEV66_TEST_SUPERUSER_DATABASE_URL superuser, used only to seed and clean up fixtures
 */
const runtimeUrl = process.env.DEV66_TEST_RUNTIME_DATABASE_URL;
const superuserUrl = process.env.DEV66_TEST_SUPERUSER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && superuserUrl ? describe : describe.skip;

const TABLE = 'pharmacy_competitor_price_observations';

describeIfDatabase('DEV-66 competitor price log tenant and branch isolation', () => {
  const run = randomUUID().slice(0, 8);
  const orgA = `dev66-org-a-${run}`;
  const orgB = `dev66-org-b-${run}`;
  const branchA1 = `dev66-branch-a1-${run}`;
  const branchA2 = `dev66-branch-a2-${run}`;
  const branchB1 = `dev66-branch-b1-${run}`;
  const obsA1 = `dev66-obs-a1-${run}`;
  const obsA2 = `dev66-obs-a2-${run}`;
  const obsB1 = `dev66-obs-b1-${run}`;
  const allIds = [obsA1, obsA2, obsB1];

  let runtime: Client;
  let su: Client;

  beforeAll(async () => {
    for (const url of [runtimeUrl!, superuserUrl!]) {
      const parsed = new URL(url);
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname))
        throw new Error('Refusing to run DEV-66 RLS probes against a non-local database.');
    }
    runtime = new Client({ connectionString: runtimeUrl });
    su = new Client({ connectionString: superuserUrl });
    await Promise.all([runtime.connect(), su.connect()]);

    // Seed as superuser. FK and append-only triggers are bypassed for this transaction
    // so only the observation rows themselves need to exist.
    await su.query('BEGIN');
    try {
      await su.query(`SET LOCAL session_replication_role = replica`);
      for (const [id, org, branch] of [
        [obsA1, orgA, branchA1],
        [obsA2, orgA, branchA2],
        [obsB1, orgB, branchB1],
      ] as const) {
        await su.query(
          `INSERT INTO "${TABLE}"
            (id,"organizationId","branchId","medicineId","packLevelId","competitorLabel",
             "observedPriceMinor","observedAt","recordedByUserId")
           VALUES ($1,$2,$3,'medicine','pack','Rival pharmacy',900,now(),'seed-actor')`,
          [id, org, branch]
        );
      }
      await su.query('COMMIT');
    } catch (error) {
      await su.query('ROLLBACK');
      throw error;
    }
  });

  afterAll(async () => {
    if (su) {
      await su.query('BEGIN');
      await su.query(`SET LOCAL session_replication_role = replica`);
      await su.query(`DELETE FROM "${TABLE}" WHERE id = ANY($1::text[])`, [allIds]);
      await su.query('COMMIT');
    }
    await Promise.all([runtime?.end(), su?.end()]);
  });

  /** Runs `work` in a rolled-back transaction with the given RLS session settings. */
  async function inScope<T>(
    scope: { org: string | null; branch: string | null; admin?: boolean },
    work: () => Promise<T>
  ): Promise<T> {
    await runtime.query('BEGIN');
    try {
      await runtime.query(`SELECT set_config('app.is_platform_admin', $1, true)`, [
        scope.admin ? 'true' : 'false',
      ]);
      await runtime.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
        scope.org ?? '',
      ]);
      await runtime.query(`SELECT set_config('app.current_branch_id', $1, true)`, [
        scope.branch ?? '',
      ]);
      return await work();
    } finally {
      await runtime.query('ROLLBACK');
    }
  }

  async function visibleIds(scope: Parameters<typeof inScope>[0]) {
    return inScope(scope, async () => {
      const { rows } = await runtime.query<{ id: string }>(
        `SELECT id FROM "${TABLE}" WHERE id = ANY($1::text[]) ORDER BY id`,
        [allIds]
      );
      return rows.map((row) => row.id).sort();
    });
  }

  function insertAs(
    scope: { org: string | null; branch: string | null },
    row: { org: string; branch: string }
  ) {
    return inScope(scope, () =>
      runtime.query(
        `INSERT INTO "${TABLE}"
          (id,"organizationId","branchId","medicineId","packLevelId","competitorLabel",
           "observedPriceMinor","observedAt","recordedByUserId")
         VALUES ($1,$2,$3,'medicine','pack','Probe',900,now(),'probe-actor')`,
        [`dev66-probe-${randomUUID()}`, row.org, row.branch]
      )
    );
  }

  it('runs as a restricted LOGIN role without SUPERUSER or BYPASSRLS', async () => {
    const result = await runtime.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(result.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('a branch reads only its own observations', async () => {
    expect(await visibleIds({ org: orgA, branch: branchA1 })).toEqual([obsA1]);
  });

  it('an organization scope without a branch reads its branches but never another tenant', async () => {
    expect(await visibleIds({ org: orgA, branch: null })).toEqual([obsA1, obsA2].sort());
  });

  it('a platform administrator reads every branch', async () => {
    expect(await visibleIds({ org: null, branch: null, admin: true })).toEqual(
      [obsA1, obsA2, obsB1].sort()
    );
  });

  it('NEGATIVE: a branch cannot insert an observation for another tenant', async () => {
    await expect(
      insertAs({ org: orgA, branch: branchA1 }, { org: orgB, branch: branchB1 })
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('NEGATIVE: a branch cannot insert an observation for a sibling branch', async () => {
    await expect(
      insertAs({ org: orgA, branch: branchA1 }, { org: orgA, branch: branchA2 })
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a branch can insert an observation for itself', async () => {
    const result = await insertAs(
      { org: orgA, branch: branchA1 },
      { org: orgA, branch: branchA1 }
    );
    expect(result.rowCount).toBe(1);
  });
});
