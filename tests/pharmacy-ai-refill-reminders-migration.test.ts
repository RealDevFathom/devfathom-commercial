import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261023200002_ai_refill_reminders/migration.sql',
  'utf8'
);

describe('AI refill reminder migration', () => {
  it('defaults each organization off and keeps reminders tenant scoped', () => {
    expect(sql).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('ALTER TABLE "pharmacy_ai_refill_reminders" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      '"organizationId" = NULLIF(current_setting(\'app.current_organization_id\', true), \'\')'
    );
  });

  it('persists approval state and pins the standard tier', () => {
    expect(sql).toContain("'DRAFT','APPROVED','SKIPPED','SENT'");
    expect(sql).toContain('"approvedByUserId" TEXT');
    expect(sql).toContain('CHECK ("aiTier" = \'standard\')');
  });
});
