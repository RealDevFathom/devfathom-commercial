import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260904196000_pharmacy_permissioned_marketing/migration.sql'
  ),
  'utf8'
);

describe('pharmacy permissioned marketing migration', () => {
  it('stores segment definitions as auditable data and rejects clinical keys in the database', () => {
    expect(sql).toContain('"definition" JSONB NOT NULL');
    expect(sql).toMatch(
      /CHECK \("definition"::text !~\* '\(prescription\|condition\|allerg\|medicine/
    );
  });

  it('forces tenant and branch RLS on every new table', () => {
    const tables = [
      'pharmacy_marketing_segments',
      'pharmacy_marketing_templates',
      'pharmacy_campaigns',
      'pharmacy_campaign_captures',
      'pharmacy_campaign_exclusions',
      'pharmacy_campaign_attributions',
    ];
    for (const table of tables) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('app.current_branch_id');
  });

  it('has no delivery/provider state and fails regulated campaigns closed', () => {
    expect(sql).not.toMatch(/provider|deliveredAt|sentAt/);
    expect(sql).toContain(
      'CHECK (NOT "promotesRegulatedItem" OR "status" IN (\'DRAFT\', \'REFUSED\'))'
    );
  });
});
