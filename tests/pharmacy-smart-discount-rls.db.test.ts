// @vitest-environment node
/**
 * DEV-66 — run the smart-discount migration itself against PostgreSQL.
 *
 * The migration is applied twice (it must be idempotent) into an isolated schema
 * that holds only the tables it references, as the NOSUPERUSER / NOBYPASSRLS owner
 * of a disposable database. The competitor price log is then exercised with real
 * rows across two organizations, each with two branches: forced tenant and branch
 * row-level security on reads and inserts, an append-only log (no UPDATE or DELETE
 * policy), and the platform administrator's cross-tenant read. The owner's maximum
 * discount column is bounded to 0..100%.
 *
 * Needs OWNER_DATABASE_URL (the QA gate owner); without it the suite is skipped.
 * The schema is dropped afterwards.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261118122400_pharmacy_smart_discount/migration.sql',
  'utf8'
);
const schema = `smart_discount_${randomUUID().replaceAll('-', '')}`;
const ORG_A = 'org_dev66_a';
const ORG_B = 'org_dev66_b';

describe.skipIf(!url)('DEV-66 smart-discount migration on PostgreSQL', () => {
  const client = new Client({ connectionString: url });

  /** One transaction with the tenant (and optional branch) settings the app sets. */
  const as = async <T>(
    context: { organizationId?: string; branchId?: string; platformAdmin?: boolean },
    work: () => Promise<T>
  ) => {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.current_branch_id', $2, true),
              set_config('app.is_platform_admin', $3, true)`,
      [context.organizationId ?? '', context.branchId ?? '', context.platformAdmin ? 'true' : '']
    );
    try {
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  const insert = (organizationId: string, branchId: string, price = 900) =>
    client.query(
      `INSERT INTO pharmacy_competitor_price_observations
         (id, "organizationId", "branchId", "medicineId", "packLevelId", "competitorLabel",
          "observedPriceMinor", "observedAt", "recordedByUserId")
       VALUES ($1, $2, $3, 'med-' || $2, 'pack-' || $2, 'Store across the road', $4, now(), 'user-a')`,
      [randomUUID(), organizationId, branchId, price]
    );

  const visible = async () =>
    (
      await client.query(
        `SELECT "organizationId", "branchId" FROM pharmacy_competitor_price_observations
          ORDER BY "organizationId", "branchId"`
      )
    ).rows;

  const expectCode = async (code: string, work: () => Promise<unknown>) => {
    await expect(work()).rejects.toMatchObject({ code });
  };

  beforeAll(async () => {
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    // RLS must actually apply to this connection, or the isolation checks prove nothing.
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE organizations (id text PRIMARY KEY);
      CREATE TABLE pharmacy_branches (id text, "organizationId" text, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_medicines (id text, "organizationId" text, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_pack_levels (id text, "organizationId" text, UNIQUE ("organizationId", id));
      INSERT INTO organizations VALUES ('${ORG_A}'), ('${ORG_B}');
      INSERT INTO pharmacy_branches VALUES
        ('branch-a1', '${ORG_A}'), ('branch-a2', '${ORG_A}'),
        ('branch-b1', '${ORG_B}'), ('branch-b2', '${ORG_B}');
      INSERT INTO pharmacy_medicines VALUES ('med-${ORG_A}', '${ORG_A}'), ('med-${ORG_B}', '${ORG_B}');
      INSERT INTO pharmacy_pack_levels VALUES ('pack-${ORG_A}', '${ORG_A}'), ('pack-${ORG_B}', '${ORG_B}');`);
    // Twice: a re-run must neither fail nor duplicate anything.
    await client.query(migration);
    await client.query(migration);
    for (const [organizationId, branchId] of [
      [ORG_A, 'branch-a1'],
      [ORG_A, 'branch-a2'],
      [ORG_B, 'branch-b1'],
      [ORG_B, 'branch-b2'],
    ] as const)
      await as({ organizationId, branchId }, () => insert(organizationId, branchId));
  }, 30_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  });

  it('forces row-level security with SELECT and INSERT policies only', async () => {
    const table = await client.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'pharmacy_competitor_price_observations'`,
      [schema]
    );
    expect(table.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await client.query(
      `SELECT cmd FROM pg_policies WHERE schemaname = $1
          AND tablename = 'pharmacy_competitor_price_observations' ORDER BY cmd`,
      [schema]
    );
    expect(policies.rows.map((row) => row.cmd)).toEqual(['INSERT', 'SELECT']);
  });

  it("shows a branch only its own observations, never another branch's or tenant's", async () => {
    await expect(as({ organizationId: ORG_A, branchId: 'branch-a1' }, visible)).resolves.toEqual([
      { organizationId: ORG_A, branchId: 'branch-a1' },
    ]);
    await expect(as({ organizationId: ORG_B, branchId: 'branch-b2' }, visible)).resolves.toEqual([
      { organizationId: ORG_B, branchId: 'branch-b2' },
    ]);
  });

  it('shows an organization-wide session every branch of its own tenant only', async () => {
    await expect(as({ organizationId: ORG_A }, visible)).resolves.toEqual([
      { organizationId: ORG_A, branchId: 'branch-a1' },
      { organizationId: ORG_A, branchId: 'branch-a2' },
    ]);
    await expect(as({}, visible)).resolves.toEqual([]);
  });

  it("refuses an insert into another branch or another tenant's log", async () => {
    await expectCode('42501', () =>
      as({ organizationId: ORG_A, branchId: 'branch-a1' }, () => insert(ORG_A, 'branch-a2'))
    );
    await expectCode('42501', () =>
      as({ organizationId: ORG_A, branchId: 'branch-a1' }, () => insert(ORG_B, 'branch-b1'))
    );
    await expectCode('42501', () => as({}, () => insert(ORG_A, 'branch-a1')));
  });

  it('keeps the log append-only: no row can be changed or removed', async () => {
    const changed = await as({ organizationId: ORG_A, branchId: 'branch-a1' }, () =>
      client.query(`UPDATE pharmacy_competitor_price_observations SET "observedPriceMinor" = 1`)
    );
    const removed = await as({ organizationId: ORG_A, branchId: 'branch-a1' }, () =>
      client.query(`DELETE FROM pharmacy_competitor_price_observations`)
    );
    expect(changed.rowCount).toBe(0);
    expect(removed.rowCount).toBe(0);
    await expect(
      as({ organizationId: ORG_A, branchId: 'branch-a1' }, visible)
    ).resolves.toHaveLength(1);
  });

  it('lets the platform administrator read every tenant', async () => {
    await expect(as({ platformAdmin: true }, visible)).resolves.toHaveLength(4);
  });

  it("stores the owner's maximum discount with a 10% default, bounded to 0..100%", async () => {
    const stored = await client.query(
      `SELECT "pharmacyMaxDiscountBps" AS bps FROM organizations WHERE id = $1`,
      [ORG_A]
    );
    expect(stored.rows).toEqual([{ bps: 1_000 }]);
    await client.query(`UPDATE organizations SET "pharmacyMaxDiscountBps" = 2500 WHERE id = $1`, [
      ORG_A,
    ]);
    for (const bps of [-1, 10_001])
      await expectCode('23514', () =>
        client.query(`UPDATE organizations SET "pharmacyMaxDiscountBps" = $2 WHERE id = $1`, [
          ORG_A,
          bps,
        ])
      );
  });
});
