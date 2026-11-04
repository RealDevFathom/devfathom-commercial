// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261021183000_qa233_pg_trgm_app_execute/migration.sql',
  'utf8'
);

describe('QA-233 pg_trgm grant migration', () => {
  it('checks that devfathom_app exists before any privilege check names it', () => {
    const guard = sql.indexOf(
      "IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'devfathom_app') THEN"
    );
    const firstRoleReference = sql.indexOf("has_function_privilege('devfathom_app'");
    expect(guard).toBeGreaterThan(-1);
    expect(firstRoleReference).toBeGreaterThan(guard);
    expect(sql.slice(guard, firstRoleReference)).toContain('RETURN;');
  });
});
