import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// DEV-911: the owner setting for the pharmacist check at each sale, in the database.
const NAME = '20261118120800_pharmacy_pharmacist_check_policy';
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');

function section(start: string, end: string): string {
  const from = sql.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = sql.indexOf(end, from + start.length);
  return sql.slice(from, to < 0 ? undefined : to);
}

describe('pharmacist check policy migration', () => {
  it('is transactional, idempotent and listed last in the migration ledger', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "pharmacistCheckEnabled" BOOLEAN NOT NULL DEFAULT true'
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).toContain('DROP TRIGGER IF EXISTS pharmacy_owner_policy_pharmacist_check_guard');
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    expect(ledger).toContain(NAME);
  });

  it('defaults to on, and a missing row or anything but a stored false means on', () => {
    const enforced = section('FUNCTION pharmacy_pharmacist_check_enforced', 'END $$;');
    expect(enforced).toContain('RETURN enabled IS DISTINCT FROM false;');
  });

  it('lets only the system owner change it, and turning it off needs the disclaimer', () => {
    const guard = section('FUNCTION pharmacy_owner_policy_pharmacist_check_guard', 'END $$;');
    expect(guard).toContain(`r."isSystem" AND r."key" = 'owner'`);
    expect(guard).not.toContain(`u."role" = 'ADMIN'`);
    expect(guard).toContain("current_setting('app.current_user_id', true)");
    expect(guard).toContain('PHARMACIST_CHECK_DISCLAIMER_REQUIRED');
    expect(guard).toContain('"pharmacistCheckPolicyVersion"');
  });

  it('writes the accepted disclaimer into the append-only audit and keeps the other settings', () => {
    const audit = section('FUNCTION pharmacy_owner_policy_audit_change', 'END $$;');
    expect(audit).toContain(`'allowCashierRxSale'`);
    expect(audit).toContain(`'supplierComplianceChecksEnabled'`);
    expect(audit).toContain(`'pharmacistCheckEnabled'`);
    expect(audit).toContain('NEW."pharmacistCheckAcknowledgement"');
  });

  it('keeps the independent register witness except for a proven check-off sale entry', () => {
    const check = section(
      'ADD CONSTRAINT "pharmacy_controlled_register_independent_witness"',
      ');\n  END IF;'
    );
    expect(check).toContain('"recordedByUserId" <> "witnessedByUserId"');
    expect(check).toContain(`COALESCE("signatureRef", '') LIKE 'solo-pin:%'`);
    expect(check).toContain(`"entryKind" = 'SALE'`);
    expect(check).toContain(`COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'`);
    const guard = section(
      'FUNCTION pharmacy_controlled_register_pharmacist_check_off_guard',
      'END $$;'
    );
    expect(guard).toContain('pharmacy_pharmacist_check_enforced(NEW."organizationId")');
    expect(guard).toContain(`'pharmacist-check-off:v' || current_version::text`);
  });

  it('keeps every register shape and adds only the marked check-off sale entry', () => {
    const shape = section(
      'ADD CONSTRAINT "pharmacy_controlled_register_kind_shape"',
      ');\n  END IF;'
    );
    expect(shape).toContain('"patientId" IS NOT NULL');
    expect(shape).toContain('"prescriberId" IS NOT NULL');
    expect(shape).toContain(`"entryKind" = 'PURCHASE'`);
    expect(shape).toContain(`"entryKind" = 'CORRECTION'`);
    expect(shape).toContain(`COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'`);
  });

  it('accepts the marker on a void or return correction only when it is stock-backed', () => {
    const check = section(
      'ADD CONSTRAINT "pharmacy_controlled_register_independent_witness"',
      ');\n  END IF;'
    );
    expect(check).toContain(`"entryKind" = 'CORRECTION' AND "restorationMovementId" IS NOT NULL`);
    const guard = section(
      'FUNCTION pharmacy_controlled_register_pharmacist_check_off_guard',
      'END $$;'
    );
    expect(guard).toContain(
      `NEW."entryKind" = 'CORRECTION' AND NEW."restorationMovementId" IS NOT NULL`
    );
  });

  it('accepts a refill approval marker only while the setting is off at that version', () => {
    const guard = section('FUNCTION pharmacy_refill_cycle_pharmacist_check_off_guard', 'END $$;');
    expect(guard).toContain('pharmacy_pharmacist_check_enforced(NEW."organizationId")');
    expect(guard).toContain(`'pharmacist-check-off:v' || current_version::text`);
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "pharmacy_refill_subscription_cycles"');
    // The refill approval CHECK itself is kept, not dropped.
    expect(sql).not.toContain('pharmacy_refill_cycles_rx_approval_ck');
  });

  it('does not touch row-level security', () => {
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
  });
});
