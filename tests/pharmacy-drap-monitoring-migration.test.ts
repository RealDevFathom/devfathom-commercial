import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260905030000_pharmacy_drap_monitoring/migration.sql',
  'utf8'
);

describe('WHA-1335 DRAP storage contract', () => {
  it('forces organization and branch RLS on every new table', () => {
    expect(migration.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration).toContain("['pharmacy_drap_ingests','pharmacy_price_change_proposals']");
    expect(migration).toContain('pharmacy_recall_quarantine_actions');
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('pins idempotency and pharmacist audit constraints', () => {
    expect(migration).toContain('UNIQUE ("organizationId","sourceReference","kind")');
    expect(migration).toContain(
      'UNIQUE ("organizationId","ingestId","inventoryLotId","stockLocationId")'
    );
    expect(migration).toContain('"confirmedById" IS NOT NULL');
    expect(migration).toContain('"reversedById"');
  });
});
