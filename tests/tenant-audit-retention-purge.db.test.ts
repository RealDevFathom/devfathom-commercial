/** @vitest-environment node */
/**
 * DEV-155 (#620) with DEV-96 (#1165): the one tenant-context DELETE the
 * append-only audit ledger admits, the pharmacy retention purge of a row whose
 * confirmed retention period has ended (20261102150000).
 *
 * The rule needs DEV-96's public.pharmacy_record_retention_deadline(). Each case
 * runs in one owner transaction that is always rolled back: it creates its own
 * tenant and audit row, and, where the case needs it, a stand-in for that
 * function with the same signature. The stand-in checks the arguments the
 * trigger passes and returns the deadline the case sets. Because DDL is
 * transactional, nothing persists and no other session ever sees the stand-in,
 * even when the real function is installed.
 *
 * Requires OWNER_DATABASE_URL: a migrated, throwaway database, as a role that may
 * CREATE FUNCTION in schema public (the migration owner). TEST_DATABASE_URL, the
 * NOSUPERUSER NOBYPASSRLS runtime role, is used for one case under forced RLS
 * when the owner may SET ROLE to it. Skipped without OWNER_DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env.OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (ownerUrl && ownerUrl === runtimeUrl) {
  throw new Error('OWNER_DATABASE_URL and TEST_DATABASE_URL must name different roles');
}
const describeIfDatabase = ownerUrl ? describe : describe.skip;

const DEADLINE_FN = 'public.pharmacy_record_retention_deadline(text,text,text,text)';

const suffix = randomBytes(6).toString('hex');
const PHARMACY = `audit_ret_ph_${suffix}`;
const AGENCY = `audit_ret_ag_${suffix}`;
const ROW = `audit_ret_row_${suffix}`;

type Attempt =
  { ok: true; rowCount: number } | { ok: false; code: string | undefined; message: string };

describeIfDatabase('pharmacy retention purge of expired tenant audit rows', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  let realDeadlineFunctionInstalled = false;

  beforeAll(async () => {
    await owner.connect();
    const { rows } = await owner.query<{ installed: boolean }>(
      `SELECT to_regprocedure($1) IS NOT NULL AS installed`,
      [DEADLINE_FN]
    );
    realDeadlineFunctionInstalled = rows[0].installed;
  });

  afterAll(async () => {
    await owner.end();
  });

  /** One case: a transaction that is always rolled back. */
  async function inRolledBackTransaction(fn: () => Promise<void>) {
    await owner.query('BEGIN');
    try {
      await fn();
    } finally {
      await owner.query('ROLLBACK');
    }
  }

  async function seed(organizationId: string, vertical: 'PHARMACY' | 'AGENCY') {
    await platformContext();
    await owner.query(
      `INSERT INTO "organizations" ("id", "slug", "legalName", "displayName", "vertical", "updatedAt")
       VALUES ($1, $2, $1, $1, $3::"OrganizationVertical", now())`,
      [organizationId, organizationId.replaceAll('_', '-'), vertical]
    );
    await owner.query(
      `INSERT INTO "audit_logs" ("id", "organizationId", "source", "category", "action")
       VALUES ($1, $2, 'SYSTEM', 'SYSTEM', 'test.retention-purge')`,
      [`${ROW}_${organizationId}`, organizationId]
    );
  }

  const rowOf = (organizationId: string) => `${ROW}_${organizationId}`;

  async function platformContext() {
    await owner.query(
      `SELECT set_config('app.is_platform_admin', 'true', true),
              set_config('app.current_organization_id', '', true),
              set_config('app.retention_purge_organization_id', '', true)`
    );
  }

  /** What withTenantDb sets, plus the purge flag DEV-96 sets before deleting. */
  async function tenantContext(organizationId: string, retentionPurgeOf: string | null) {
    await owner.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true),
              set_config('app.purging_organization_id', '', true),
              set_config('app.retention_purge_organization_id', $2, true)`,
      [organizationId, retentionPurgeOf ?? '']
    );
  }

  /**
   * Stand-in for DEV-96's deadline function, same signature and parameter names
   * so CREATE OR REPLACE also works over the real one. It refuses unexpected
   * arguments, then returns test.retention_deadline (NULL when empty) or raises
   * the 55000 refusal the real function raises for a row under legal hold.
   */
  async function installDeadlineStandIn() {
    await owner.query(`
      CREATE OR REPLACE FUNCTION public.pharmacy_record_retention_deadline(
        organization_id text, record_class text, record_id text, expected_branch_id text DEFAULT NULL
      ) RETURNS timestamp LANGUAGE plpgsql AS $fn$
      BEGIN
        IF record_class IS DISTINCT FROM 'AUDIT'
           OR expected_branch_id IS NOT NULL
           OR organization_id IS DISTINCT FROM current_setting('test.expected_organization_id', true)
           OR record_id IS DISTINCT FROM current_setting('test.expected_record_id', true) THEN
          RAISE EXCEPTION 'stand-in called with unexpected arguments: %, %, %, %',
            organization_id, record_class, record_id, expected_branch_id USING ERRCODE = 'P0001';
        END IF;
        IF current_setting('test.retention_refusal', true) = 'hold' THEN
          RAISE EXCEPTION 'deletion refused: record is protected by legal hold' USING ERRCODE = '55000';
        END IF;
        RETURN NULLIF(current_setting('test.retention_deadline', true), '')::timestamp;
      END
      $fn$`);
  }

  /** deadline: a SQL timestamp literal, 'past', 'future', or null for a NULL result. */
  async function setDeadline(organizationId: string, deadline: 'past' | 'future' | string | null) {
    const { rows } = await owner.query<{ value: string }>(
      `SELECT CASE $1::text
                WHEN 'past' THEN ((clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day')::text
                WHEN 'future' THEN ((clock_timestamp() AT TIME ZONE 'UTC') + interval '1 day')::text
                ELSE coalesce($1::text, '')
              END AS value`,
      [deadline]
    );
    await owner.query(
      `SELECT set_config('test.retention_deadline', $1, true),
              set_config('test.expected_organization_id', $2, true),
              set_config('test.expected_record_id', $3, true),
              set_config('test.retention_refusal', '', true)`,
      [rows[0].value, organizationId, rowOf(organizationId)]
    );
  }

  async function attempt(sql: string, params: unknown[]): Promise<Attempt> {
    await owner.query('SAVEPOINT retention_attempt');
    try {
      const result = await owner.query(sql, params);
      await owner.query('RELEASE SAVEPOINT retention_attempt');
      return { ok: true, rowCount: result.rowCount ?? 0 };
    } catch (error) {
      await owner.query('ROLLBACK TO SAVEPOINT retention_attempt');
      const failure = error as { code?: string; message?: string };
      return { ok: false, code: failure.code, message: String(failure.message) };
    }
  }

  const deleteRow = (organizationId: string) =>
    attempt(`DELETE FROM "audit_logs" WHERE "id" = $1`, [rowOf(organizationId)]);

  async function stillStored(organizationId: string) {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const { rows } = await owner.query<{ action: string }>(
      `SELECT "action" FROM "audit_logs" WHERE "id" = $1`,
      [rowOf(organizationId)]
    );
    return rows[0]?.action ?? null;
  }

  function expectAppendOnlyRefusal(result: Attempt, operation: 'DELETE' | 'UPDATE') {
    expect(result).toMatchObject({ ok: false, code: '55000' });
    if (!result.ok) {
      expect(result.message).toBe(`audit_logs is append-only: ${operation} is forbidden`);
    }
  }

  /** A pharmacy tenant, its own context and purge flag, and an expired row. */
  async function expiredPharmacyRowInPurge() {
    await seed(PHARMACY, 'PHARMACY');
    await installDeadlineStandIn();
    await setDeadline(PHARMACY, 'past');
    await tenantContext(PHARMACY, PHARMACY);
  }

  it('admits the purge of an expired pharmacy row in its own tenant context', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await expect(deleteRow(PHARMACY)).resolves.toEqual({ ok: true, rowCount: 1 });
      await expect(stillStored(PHARMACY)).resolves.toBeNull();
    });
  });

  it('refuses the same delete without the retention purge flag', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await tenantContext(PHARMACY, null);
      expectAppendOnlyRefusal(await deleteRow(PHARMACY), 'DELETE');
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses a purge flag that names another tenant', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await seed(AGENCY, 'AGENCY');
      await tenantContext(PHARMACY, AGENCY);
      expectAppendOnlyRefusal(await deleteRow(PHARMACY), 'DELETE');
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses when the tenant context is another tenant or absent', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await seed(AGENCY, 'AGENCY');
      for (const context of [AGENCY, '']) {
        await owner.query(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.is_platform_admin', 'false', true),
                  set_config('app.retention_purge_organization_id', $2, true)`,
          [context, PHARMACY]
        );
        // A superuser owner bypasses RLS, so the trigger must refuse. An owner
        // under forced RLS does not even see the row: nothing is deleted.
        const result = await deleteRow(PHARMACY);
        if (result.ok) expect(result.rowCount).toBe(0);
        else expectAppendOnlyRefusal(result, 'DELETE');
      }
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses a tenant that is not a pharmacy', async () => {
    await inRolledBackTransaction(async () => {
      await seed(AGENCY, 'AGENCY');
      await installDeadlineStandIn();
      await setDeadline(AGENCY, 'past');
      await tenantContext(AGENCY, AGENCY);
      expectAppendOnlyRefusal(await deleteRow(AGENCY), 'DELETE');
      await expect(stillStored(AGENCY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses a row whose retention period has not ended', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await setDeadline(PHARMACY, 'future');
      const result = await deleteRow(PHARMACY);
      expect(result).toMatchObject({ ok: false, code: '55000' });
      // With DEV-96 installed its own guard may refuse first ("retained until").
      if (!result.ok) {
        expect(result.message).toMatch(/append-only: DELETE is forbidden|retained until/);
      }
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses a missing or non-finite deadline', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      for (const deadline of [null, '-infinity', 'infinity']) {
        await setDeadline(PHARMACY, deadline);
        const result = await deleteRow(PHARMACY);
        expect(result).toMatchObject({ ok: false });
        await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
        await tenantContext(PHARMACY, PHARMACY);
      }
    });
  });

  it("passes on the deadline function's own refusal unchanged", async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await owner.query(`SELECT set_config('test.retention_refusal', 'hold', true)`);
      const result = await deleteRow(PHARMACY);
      expect(result).toMatchObject({
        ok: false,
        code: '55000',
        message: 'deletion refused: record is protected by legal hold',
      });
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('refuses every purge while the DEV-96 deadline function is not installed', async (context) => {
    if (realDeadlineFunctionInstalled) {
      context.skip('DEV-96 installed the real function; its own suite covers this path');
    }
    await inRolledBackTransaction(async () => {
      await seed(PHARMACY, 'PHARMACY');
      await tenantContext(PHARMACY, PHARMACY);
      expectAppendOnlyRefusal(await deleteRow(PHARMACY), 'DELETE');
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('still refuses UPDATE in the retention purge context', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      expectAppendOnlyRefusal(
        await attempt(`UPDATE "audit_logs" SET "action" = 'tampered' WHERE "id" = $1`, [
          rowOf(PHARMACY),
        ]),
        'UPDATE'
      );
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('keeps a row under an active legal hold even when it has expired', async () => {
    await inRolledBackTransaction(async () => {
      await expiredPharmacyRowInPurge();
      await platformContext();
      await owner.query(
        `INSERT INTO "pharmacy_legal_hold_events"
           ("id", "organizationId", "holdKey", "recordClass", "recordId", "kind", "reason", "actorUserId")
         VALUES ($1, $2, 'case-1', 'AUDIT', $3, 'PLACED', 'Regulator inquiry', 'test-actor')`,
        [`${ROW}_hold`, PHARMACY, rowOf(PHARMACY)]
      );
      await tenantContext(PHARMACY, PHARMACY);
      const result = await deleteRow(PHARMACY);
      expect(result).toMatchObject({ ok: false, code: '55000' });
      if (!result.ok) expect(result.message).toMatch(/legal hold/);
      await expect(stillStored(PHARMACY)).resolves.toBe('test.retention-purge');
    });
  });

  it('admits the purge as the runtime role under forced RLS', async (context) => {
    const runtimeRole = runtimeUrl ? decodeURIComponent(new URL(runtimeUrl).username) : '';
    const { rows } = await owner.query<{ allowed: boolean }>(
      `SELECT $1::text <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
              AND pg_has_role(current_user, $1, 'MEMBER') AS allowed`,
      [runtimeRole]
    );
    if (!rows[0].allowed) {
      context.skip('needs TEST_DATABASE_URL and an owner that may SET ROLE to its role');
    }
    await inRolledBackTransaction(async () => {
      await seed(PHARMACY, 'PHARMACY');
      await installDeadlineStandIn();
      await setDeadline(PHARMACY, 'past');
      await owner.query(`SELECT set_config('role', $1, true)`, [runtimeRole]);
      const { rows: who } = await owner.query<{ bypass: boolean }>(
        `SELECT rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = current_user`
      );
      expect(who[0].bypass).toBe(false);
      await tenantContext(PHARMACY, PHARMACY);
      await expect(deleteRow(PHARMACY)).resolves.toEqual({ ok: true, rowCount: 1 });
      await tenantContext(PHARMACY, null);
      const { rows: left } = await owner.query(`SELECT 1 FROM "audit_logs" WHERE "id" = $1`, [
        rowOf(PHARMACY),
      ]);
      expect(left).toHaveLength(0);
    });
  });
});
