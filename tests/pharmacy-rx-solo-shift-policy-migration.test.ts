import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// DEV-960: the owner setting "One pharmacist per shift", per branch, in the database.
const NAME = '20261118125100_pharmacy_rx_solo_shift_policy';
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');
const TABLE = '"pharmacy_rx_solo_shift_policy_changes"';

function section(start: string, end: string): string {
  const from = sql.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = sql.indexOf(end, from + start.length);
  return sql.slice(from, to < 0 ? undefined : to);
}

describe('one pharmacist per shift policy migration', () => {
  it('is transactional, idempotent and listed last in the migration ledger', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${TABLE}`);
    expect(sql).toContain('DROP TRIGGER IF EXISTS pharmacy_rx_solo_shift_policy_guard');
    expect(sql).toContain('DROP TRIGGER IF EXISTS pharmacy_rx_solo_shift_policy_append_only');
    expect(sql).toContain(`DROP POLICY IF EXISTS tenant_branch_isolation ON ${TABLE}`);
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    expect(ledger).toContain(NAME);
    // Later migrations (DEV-962 onwards) follow it in the ledger, each stamped after it.
    const later = ledger.slice(ledger.indexOf(NAME) + 1);
    for (const name of later) expect(name.slice(0, 14) > NAME.slice(0, 14), name).toBe(true);
    const stamps = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(stamps.filter((name) => name.slice(0, 14) > NAME.slice(0, 14))).toEqual(later);
  });

  it('forces row-level security by organization and branch', () => {
    expect(sql).toContain(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;`);
    const policy = section(`CREATE POLICY tenant_branch_isolation ON ${TABLE}`, ');\n\nCOMMIT');
    expect(policy).toContain(
      `"organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')`
    );
    expect(policy).toContain(`"branchId" = current_setting('app.current_branch_id', true)`);
    expect(policy).toContain('WITH CHECK');
  });

  it('keeps every change: rows are never updated or deleted', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER pharmacy_rx_solo_shift_policy_append_only\s+BEFORE UPDATE OR DELETE ON "pharmacy_rx_solo_shift_policy_changes"\s+FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation\(\);/
    );
  });

  it('lets only the live system owner change it, and turning it on needs the statement', () => {
    const guard = section('FUNCTION pharmacy_rx_solo_shift_policy_guard', 'END $$;');
    expect(guard).toContain(`r."isSystem" AND r."key" = 'owner'`);
    expect(guard).not.toContain(`u."role" = 'ADMIN'`);
    expect(guard).toContain(`u."status" = 'ACTIVE'`);
    expect(guard).toContain("current_setting('app.current_user_id', true)");
    expect(guard).toContain(`'*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:dispense'`);
    expect(guard).toContain('RX_SOLO_SHIFT_POLICY_OWNER_REQUIRED');
    expect(guard).toContain('RX_SOLO_SHIFT_POLICY_DISCLAIMER_REQUIRED');
    expect(guard).toContain('RX_SOLO_SHIFT_POLICY_UNCHANGED');
    // The database numbers the version and serializes changes on the branch's setting lock.
    expect(guard).toContain('NEW."version" := last_version + 1;');
    expect(guard).toContain('pg_advisory_xact_lock(pharmacy_rx_solo_shift_lock_key');
    // No row means off.
    expect(guard).toContain('last_enabled := false;');
  });

  it('leaves the prescription review trigger (DEV-950) as it is', () => {
    expect(sql).not.toContain('pharmacy_rx_reject_review_self_approval');
    expect(sql).not.toContain('pharmacy_pharmacist_review_decisions');
  });
});
