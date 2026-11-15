import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261116100200_pharmacy_drap_recall_review_queue/migration.sql'
  ),
  'utf8'
);

describe('DEV-692 DRAP recall review-queue migration', () => {
  it('is transactional and idempotent', () => {
    const body = sql.replace(/^--.*\n/gm, '').trim();
    expect(body.startsWith('BEGIN;')).toBe(true);
    expect(body.endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'PharmacyDrapReviewStatus'\)/
    );
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "pharmacy_drap_ingests_review_check"/);
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_drap_recall_feed_runs"/
    );
  });

  it('forces row-level security on the new tenant table', () => {
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_drap_recall_feed_runs" ENABLE ROW LEVEL SECURITY;'
    );
    expect(sql).toContain('ALTER TABLE "pharmacy_drap_recall_feed_runs" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain("NULLIF(current_setting('app.current_organization_id', true), '')");
  });

  it('admits the DRAP_WEB adapter and pins the review audit trail in the database', () => {
    expect(sql).toContain(`CHECK ("adapter" IN ('FILE','MANUAL','DRAP_WEB'))`);
    // Pending drafts cannot carry a recall; confirmed ones must, with reviewer and time.
    expect(sql).toMatch(/'PENDING_REVIEW'\s+AND "recallNoticeId" IS NULL/);
    expect(sql).toMatch(
      /'CONFIRMED' AND "recallNoticeId" IS NOT NULL\s+AND length\(btrim\("reviewedById"\)\) > 0/
    );
    expect(sql).toMatch(/'DISMISSED'[\s\S]*length\(btrim\("reviewNote"\)\) > 0/);
  });
});
