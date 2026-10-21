import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20260904193000_pharmacy_family_khata/migration.sql',
  'utf8'
);
const tables = [
  'pharmacy_family_accounts',
  'pharmacy_family_members',
  'pharmacy_khata_events',
  'pharmacy_khata_limit_decisions',
];

describe('CRM-L02/CRM-L04 migration contract', () => {
  it('puts every table under forced tenant and branch RLS', () => {
    for (const table of tables) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting(''app.current_branch_id'', true)");
  });

  it('keeps clinical detail out of family and khata tables', () => {
    for (const forbidden of ['prescriptionId', 'condition', 'allergy', 'medicineId'])
      expect(sql).not.toContain(forbidden);
  });

  it('makes financial history and owner decisions append-only', () => {
    expect(sql).toContain('pharmacy_khata_events_append_only');
    expect(sql).toContain('pharmacy_khata_limit_decisions_append_only');
  });
});
