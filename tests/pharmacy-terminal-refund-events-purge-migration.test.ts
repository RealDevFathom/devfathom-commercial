import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const NAME = '20261127090000_pharmacy_terminal_refund_events_purge';
const ORIGINAL = '20261122010000_pharmacy_terminal_refund_events';
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');
/** The statements, without the header and inline comments. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('DEV-1056 card-terminal refund events purge migration contract', () => {
  it('is one idempotent transaction, stamped after every earlier migration', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain('DROP POLICY IF EXISTS terminal_refund_scope');
    expect(code).toContain('CREATE OR REPLACE FUNCTION pharmacy_terminal_refund_immutable()');
    // The table, its trigger binding and row level security are left as they are.
    expect(code).not.toMatch(
      /DROP TABLE|DROP TRIGGER|CREATE TRIGGER|DELETE FROM|\bTRUNCATE\b|\bDISABLE\b|NO FORCE/
    );
    const migrations = readdirSync('prisma/migrations')
      .filter((entry) => /^\d{14}_/.test(entry))
      .sort();
    expect(migrations.indexOf(NAME)).toBeGreaterThan(migrations.indexOf(ORIGINAL));
  });

  it('keeps the tenant and branch scope, and adds the platform-admin exception to USING only', () => {
    const policy = code.slice(
      code.indexOf('CREATE POLICY terminal_refund_scope'),
      code.indexOf('CREATE OR REPLACE FUNCTION')
    );
    const scope = (clause: string) => clause.replace(/\s+/g, ' ');
    const using = scope(policy.slice(policy.indexOf('USING ('), policy.indexOf('WITH CHECK (')));
    const check = scope(policy.slice(policy.indexOf('WITH CHECK (')));
    for (const clause of [using, check]) {
      expect(clause).toContain(
        `"organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')`
      );
      expect(clause).toContain(
        `NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true)`
      );
    }
    // The purge reads and deletes through USING.
    expect(using).toContain(`current_setting('app.is_platform_admin', true) = 'true' OR (`);
    // WITH CHECK decides what may be written: the control plane must not INSERT a refund
    // event, so it is exactly the tenant and branch scope of the original migration.
    expect(check).not.toContain('app.is_platform_admin');
    expect(check).not.toMatch(/\bOR \(/);
    expect(check).toBe(
      `WITH CHECK ( "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND ( NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true) ) ); `
    );
  });

  it('admits a DELETE only in the platform purge of the row’s own tenant, and never an UPDATE', () => {
    const body = code.slice(
      code.indexOf('CREATE OR REPLACE FUNCTION pharmacy_terminal_refund_immutable()'),
      code.indexOf('END $$;')
    );
    expect(body.replace(/\s+/g, ' ')).toContain(
      `IF TG_OP = 'DELETE' AND current_setting('app.is_platform_admin', true) = 'true' AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN RETURN OLD; END IF; RAISE EXCEPTION 'card terminal refund events are append-only' USING ERRCODE='55000';`
    );
    // One way out, and it is the DELETE above.
    expect(body.match(/RETURN (OLD|NEW)/g)).toEqual(['RETURN OLD']);
  });
});
