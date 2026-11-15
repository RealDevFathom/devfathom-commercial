import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261116130000_pharmacy_customer_portal/migration.sql',
  'utf8'
);
const tables = [
  'pharmacy_customer_portal_links',
  'pharmacy_customer_portal_sessions',
  'pharmacy_customer_portal_requests',
];

describe('DEV-15 customer PWA migration contract', () => {
  it('is one idempotent transaction', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const table of tables) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  });

  it('puts every new tenant table under forced tenant and branch RLS', () => {
    for (const table of tables) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
  });

  it('stores only hashes of sign-in links, codes and sessions', () => {
    expect(sql).toContain('"tokenHash" TEXT NOT NULL');
    expect(sql).toContain('"otpHash" TEXT');
    expect(sql).not.toMatch(/"(token|otp|sessionToken)" TEXT/);
  });

  it('requires a photo for a prescription order and an attributable staff decision', () => {
    expect(sql).toContain(`CHECK ("kind" <> 'RX_ORDER' OR "prescriptionFileRef" IS NOT NULL)`);
    expect(sql).toContain('"decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL');
  });
});
