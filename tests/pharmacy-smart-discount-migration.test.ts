import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261117100000_pharmacy_smart_discount/migration.sql',
  'utf8'
);

describe('DEV-66 smart-discount storage contract', () => {
  it('is transactional and idempotent', () => {
    expect(migration.trim().startsWith('--')).toBe(true);
    expect(migration).toContain('BEGIN;');
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "discountPolicy"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "pharmacy_competitor_price_observations"'
    );
  });

  it('forces tenant and branch RLS on the competitor log, append-only for the runtime role', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_competitor_price_observations" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_competitor_price_observations" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
    expect(migration).not.toMatch(/FOR (UPDATE|DELETE|ALL)/);
  });
});
