import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261021140000_controlled_register_sellable_balance/migration.sql',
  'utf8'
);

describe('controlled register balance migration', () => {
  it('keeps force RLS and the append-only trigger, and excludes quarantine from the stock check', () => {
    expect(sql).not.toMatch(/DROP TRIGGER[\s\S]*pharmacy_controlled_register_entries_append_only/i);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/i);
    expect(sql).toContain(`"disposition" <> 'QUARANTINE'`);
    expect(sql).toContain('pharmacy_controlled_register_entries_append_only');
  });

  it('forces tenant RLS on the emergency prescription follow-up', () => {
    expect(sql).toContain('CREATE TABLE "pharmacy_emergency_rx_follow_ups"');
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_emergency_rx_follow_ups" FORCE ROW LEVEL SECURITY'
    );
    expect(sql).toContain('tenant_isolation');
  });
});
