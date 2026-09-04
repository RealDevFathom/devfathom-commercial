import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260904190000_pharmacy_anomaly_signals/migration.sql',
  'utf8'
);

describe('WHA-1314 anomaly storage contract', () => {
  it('forces tenant and branch RLS on both new tables', () => {
    expect(migration).toContain(
      "FOREACH t IN ARRAY ARRAY['pharmacy_anomaly_signals','pharmacy_anomaly_signal_events']"
    );
    expect(migration).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('keeps decision history append-only and signal roots undeletable', () => {
    expect(migration).toContain('pharmacy_anomaly_signal_events_append_only');
    expect(migration).toContain('pharmacy_reject_append_only_change()');
    expect(migration).toContain('pharmacy_anomaly_signals_no_delete');
    expect(migration).toContain('pharmacy_reject_delete()');
  });

  it('has no operational command target or finance-posting reference', () => {
    const anomalyTables = migration.slice(
      migration.indexOf('CREATE TABLE "pharmacy_anomaly_signals"')
    );
    expect(anomalyTables).not.toMatch(/REFERENCES "pharmacy_(purchase_orders|stock_movements)"/);
    expect(anomalyTables).not.toMatch(/REFERENCES ".*(posting|journal).*"/i);
  });
});
