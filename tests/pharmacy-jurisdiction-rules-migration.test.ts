import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = '20261024160000_pharmacy_pakistan_jurisdiction_rules_pending_review';
const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8');
const executable = sql.replace(/--[^\n]*/g, '').trim();
const payloads = [...sql.matchAll(/'({"values"[^']+})'::jsonb/g)].map((match) =>
  JSON.parse(match[1])
);

describe('#129 append-only Pakistan jurisdiction migration contract', () => {
  it('uses a new, unique migration timestamp after shipped main migrations', () => {
    const names = readdirSync('prisma/migrations');
    expect(names.filter((name) => name.startsWith(migration.slice(0, 14)))).toEqual([migration]);
    expect(migration > '20261023020100_validate_prescription_sale_line_reference').toBe(true);
  });

  it.each([
    [
      '20260902130000_pharmacy_regulatory_profiles',
      'ce3eb7592645cea072ffebff5c2697321f593a911e9f94ea8040869291342111',
    ],
    [
      '20261022233600_pharmacy_placeholder_rule_set',
      '9af0248f43e3aca08e121241c3173d1e8cfa488e2d39c503e8d0ddb3b7753cd9',
    ],
    [
      '20261022235900_restore_regulatory_delete_exceptions',
      '4822f10774775a35bbf7e9d8b5f9f515d153698b03a5ee1f138888dd5b7ec8ef',
    ],
  ])('does not rewrite shipped migration %s', (name: string, hash: string) => {
    const original = readFileSync(`prisma/migrations/${name}/migration.sql`);
    expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
  });

  it('keeps schema, inserts and the platform flag in one explicit transaction', () => {
    expect(executable).toMatch(/^BEGIN;/);
    expect(executable).toMatch(/COMMIT;$/);
    expect(executable.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(executable.match(/\bCOMMIT;/g)).toHaveLength(1);
    const flag = "SELECT set_config('app.is_platform_admin', 'true', true);";
    expect(executable).toContain(flag);
    expect(executable.indexOf(flag)).toBeLessThan(executable.indexOf('INSERT INTO'));
    expect(executable).not.toMatch(/set_config\([^;]+false\)/i);
    expect(executable).not.toMatch(
      /(?:DISABLE|NO FORCE) ROW LEVEL SECURITY|(?:CREATE|DROP|ALTER) POLICY|BYPASSRLS/i
    );
  });

  it('retains all seven historical Sindh choices, each explicitly pending legal review', () => {
    expect(payloads.slice(0, 7)).toEqual(
      [
        ['RETAIL', 'WHOLESALE'],
        ['G', 'H'],
        ['H'],
        { H: 1825 },
        { H: true },
        { minimumHoursPerWeek: 40 },
        { prescription: 1825 },
      ].map((values) => ({ values, provisional: false, pendingLegalReview: true }))
    );
    expect(sql).not.toContain('pk_sd_confirmed_v1');
    expect(sql).toContain("'2026-01-01T00:00:00.000Z'::timestamp");
  });

  it('reserves historical Sindh v1/v2 and appends above existing versions under a lock', () => {
    expect(executable).toContain(
      'LOCK TABLE "pharmacy_jurisdiction_rule_sets" IN SHARE ROW EXCLUSIVE MODE'
    );
    expect(executable).toContain('GREATEST(COALESCE(MAX("version"), 0) + 1, 3)');
    expect(executable).toContain('WHERE "code" = \'PK-SD\'');
    expect(executable).toContain("'pk_sd_pending_review_v' || version, 'PK-SD', version");
    expect(executable).not.toMatch(/ON CONFLICT[^;]*DO NOTHING/i);
    expect(executable).toMatch(/EXCLUDE USING gist \("code" WITH =, "version" WITH =,/);
    expect(executable).toContain(
      'tsrange("effectiveFrom", COALESCE("effectiveTo", \'infinity\'::timestamp), \'[)\') WITH &&)'
    );
  });

  it('offers only the five missing provinces provisionally and leaves existing publications alone', () => {
    expect(executable).toContain("ARRAY['PK-KP', 'PK-BA', 'PK-ICT', 'PK-GB', 'PK-AJK']");
    expect(payloads.slice(7)).toEqual(
      [[], [], [], {}, {}, {}, {}].map((values) => ({
        values,
        provisional: true,
        toConfirm: 'Issue #129 jurisdiction counsel review',
      }))
    );
    expect(payloads).toHaveLength(14);
    expect(executable).toMatch(/WHERE NOT EXISTS \([\s\S]*existing\."code" = jurisdictions\.code/);
    expect(executable).not.toContain("'PK-PB'");
  });

  it('never rewrites rules, profiles, placeholder grants, or the append-only trigger', () => {
    expect(executable).not.toMatch(
      /\b(?:UPDATE|DELETE|TRUNCATE)\b|DROP TABLE|CREATE OR REPLACE FUNCTION/i
    );
    expect(executable).not.toMatch(
      /pharmacy_branch_regulatory_profiles|pharmacy_branches|pharmacy_reject_regulatory_rewrite|isPlaceholder/
    );
  });

  it('orders equal-date versions consistently and includes the code when evaluating a saved profile', () => {
    const router = readFileSync('src/server/routers/pharmacy-onboarding.ts', 'utf8');
    expect(router).toContain(
      "orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }, { version: 'desc' }]"
    );
    expect(router).toMatch(/jurisdictionRuleSet:\s*\{\s*select:\s*\{\s*code: true/);
    const guard = readFileSync('src/lib/pharmacy/regulatory.ts', 'utf8');
    expect(guard).toContain("orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }]");
  });
});
