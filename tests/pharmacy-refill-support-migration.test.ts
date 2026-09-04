import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20260904198000_pharmacy_refill_support/migration.sql',
  'utf8'
);

describe('RX-07 migration contract', () => {
  it('creates a capture-only patient-context reminder record', () => {
    expect(sql).toContain('pharmacy_refill_reminder_captures');
    expect(sql).toContain('"captureMode" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('"status" TEXT NOT NULL DEFAULT \'CAPTURED\'');
    expect(sql).not.toMatch(/\b(?:sentAt|deliveredAt|marketingCampaignId)\b/);
  });

  it('puts the new table under forced tenant and branch RLS', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
  });

  it('binds the capture to actual fill, consent and pharmacist evidence', () => {
    expect(sql).toContain('"prescriptionFillId" TEXT NOT NULL');
    expect(sql).toContain('"consentEventId" TEXT NOT NULL');
    expect(sql).toContain('"pharmacistDecisionId" TEXT');
    expect(sql).toContain('pharmacy_refill_capture_org_fill_key');
  });

  it('NEGATIVE: prevents mutation or promotion out of capture mode', () => {
    expect(sql).toContain('pharmacy_refill_capture_append_only');
    expect(sql).toContain('CHECK ("captureMode" AND "status" = \'CAPTURED\')');
  });
});
