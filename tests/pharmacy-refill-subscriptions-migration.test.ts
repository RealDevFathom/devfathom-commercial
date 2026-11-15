import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116090000_pharmacy_refill_subscriptions/migration.sql',
  'utf8'
);

const TABLES = ['pharmacy_refill_subscriptions', 'pharmacy_refill_subscription_cycles'] as const;

describe('DEV-73 refill subscription database contract', () => {
  it('runs in one transaction and can be re-applied', () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_refill_subscriptions"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_refill_subscription_cycles"');
    expect(migration).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
  });

  it('enables and forces branch-scoped RLS on both tenant tables', () => {
    for (const table of TABLES) expect(migration).toContain(`'${table}'`);
    expect(migration).toContain("format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t)");
    expect(migration).toContain("format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t)");
    expect(migration).toContain('tenant_branch_select');
    expect(migration).not.toMatch(/FOR DELETE|FOR ALL/);
  });

  it('holds stock through the DEM-03 reservations instead of a second reservation table', () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*reservation/i);
  });

  it('refuses an Rx cycle past AWAITING_PHARMACIST without a recorded approval', () => {
    expect(migration).toContain('"pharmacy_refill_cycles_rx_approval_ck"');
    expect(migration).toMatch(
      /NOT "requiresPharmacist"\s+OR "status" IN \('AWAITING_PHARMACIST', 'RELEASED'\)\s+OR \("approvedByUserId" IS NOT NULL AND "approvalPolicy" IS NOT NULL AND "approvedAt" IS NOT NULL\)/
    );
  });
});
