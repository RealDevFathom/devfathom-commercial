import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20260902170000_pharmacy_rx_review_substitution_controlled_register/migration.sql',
  'utf8'
);

describe('RX-03/04/05 migration contract', () => {
  it('forces tenant RLS on every new patient/register table', () => {
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    for (const table of [
      'pharmacy_pharmacist_review_items',
      'pharmacy_pharmacist_review_decisions',
      'pharmacy_substitution_records',
      'pharmacy_controlled_register_entries',
      'pharmacy_register_incidents',
      'pharmacy_register_incident_approvals',
    ])
      expect(sql).toContain(`'${table}'`);
  });
  it('enforces self-approval refusal and append-only evidence in PostgreSQL', () => {
    expect(sql).toContain('requesting cashier cannot approve pharmacist-required line');
    expect(sql).toContain('pharmacy_rx_append_only');
  });
  it('serializes reconciliation, opens incidents, and blocks subsequent dispensing', () => {
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('controlled dispensing blocked by open register incident');
    expect(sql).toContain('INSERT INTO "pharmacy_register_incidents"');
  });
});
