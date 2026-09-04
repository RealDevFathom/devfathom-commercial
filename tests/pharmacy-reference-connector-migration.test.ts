import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260905070000_pharmacy_reference_connector_automation/migration.sql',
  'utf8'
);

describe('WHA-1339 connector persistence contract', () => {
  it('forces organization RLS on state, run, and proposal tables', () => {
    for (const table of [
      'pharmacy_reference_connectors',
      'pharmacy_reference_connector_runs',
      'pharmacy_reference_connector_proposals',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('app.current_organization_id');
  });

  it('guards run evidence and one-way pharmacist decisions', () => {
    expect(migration).toContain('pharmacy_reference_connector_runs_guard');
    expect(migration).toContain('reference connector runs are audit records');
    expect(migration).toContain('pharmacy_reference_connector_proposals_guard');
    expect(migration).toContain("OLD.status <> 'PENDING'");
  });

  it('adds only the narrow pharmacist catalogue-review grant', () => {
    expect(migration).toContain("'pharmacy:catalogue-review'");
    expect(migration).toContain("organization.vertical = 'PHARMACY' AND role.key = 'pharmacist'");
    expect(migration).not.toContain('pharmacy:*');
  });
});
