import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261022190209_pharmacy_pakistan_jurisdiction_rules/migration.sql',
  'utf8'
);

describe('issue 129 Pakistan pharmacy jurisdiction rules migration', () => {
  it('publishes an operable Sindh rule set with the reviewed licence and schedule choices', () => {
    expect(sql).toContain("'pk_sd_confirmed_v1', 'PK-SD'");
    expect(sql).toContain('{"values":["RETAIL","WHOLESALE"],"provisional":false}');
    expect(sql).toContain('{"values":["G","H"],"provisional":false}');
    expect(sql).toContain('{"values":{"minimumHoursPerWeek":40},"provisional":false}');
  });

  it('keeps every other newly offered jurisdiction provisional and does not alter guards or RLS', () => {
    for (const code of ['PK-KP', 'PK-BA', 'PK-ICT', 'PK-GB', 'PK-AJK']) {
      expect(sql).toContain(`'${code}'`);
    }
    expect(sql).toContain('"provisional":true');
    expect(sql).toContain("set_config('app.is_platform_admin', 'true', true)");
    expect(sql).not.toMatch(/UPDATE\s+"?pharmacy_jurisdiction_rule_sets/i);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/pharmacy_branch_regulatory_profiles|pharmacy_reject_regulatory_rewrite/);
  });
});
