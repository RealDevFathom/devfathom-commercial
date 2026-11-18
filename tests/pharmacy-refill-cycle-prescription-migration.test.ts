import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261118120000_pharmacy_refill_cycle_prescription';
const migration = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');

describe('DEV-73 refill cycle prescription database contract', () => {
  it('runs in one transaction and can be re-applied', () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "prescriptionLineId" TEXT');
    expect(migration.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)).toHaveLength(2);
  });

  it('ties the cycle to a prescription line of the same organization', () => {
    expect(migration).toContain(
      'FOREIGN KEY ("organizationId", "prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId", "id")'
    );
  });

  it('refuses a prescription-only cycle past AWAITING_PHARMACIST without a prescription', () => {
    expect(migration).toContain('"pharmacy_refill_cycles_rx_prescription_ck"');
    expect(migration).toMatch(
      /NOT "requiresPharmacist"\s+OR "status" IN \('AWAITING_PHARMACIST', 'RELEASED'\)\s+OR "prescriptionLineId" IS NOT NULL/
    );
  });

  it('puts earlier approvals without a prescription back on hold', () => {
    expect(migration).toMatch(
      /SET "status" = 'AWAITING_PHARMACIST'\s+WHERE "organizationId" = target\."organizationId"\s+AND "branchId" = target\."branchId"\s+AND "requiresPharmacist"\s+AND "status" = 'RESERVED'\s+AND "prescriptionLineId" IS NULL/
    );
  });

  it('re-holds under each tenant branch, since the platform-admin policy only reads', () => {
    expect(migration).toContain(
      'PERFORM set_config(\'app.current_organization_id\', target."organizationId", true)'
    );
    expect(migration).toContain(
      'PERFORM set_config(\'app.current_branch_id\', target."branchId", true)'
    );
  });

  it('keeps row-level security forced on the cycle table', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_refill_subscription_cycles" FORCE ROW LEVEL SECURITY'
    );
  });

  it('is recorded at the end of the new-migration ledger', () => {
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    expect(ledger.at(-1)).toBe(NAME);
  });
});
