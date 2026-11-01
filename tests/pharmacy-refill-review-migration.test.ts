import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261024145000_pharmacy_refill_reminder_reviews/migration.sql',
  'utf8'
);

describe('G9 review migration contract', () => {
  it('adds only review metadata, with scoped capture and reviewer foreign keys', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('"pharmacy_refill_reminder_reviews"');
    expect(sql).toContain('PRIMARY KEY ("organizationId", "captureId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "branchId", "captureId")');
    expect(sql).toContain(
      'REFERENCES "pharmacy_refill_reminder_captures" ("organizationId", "branchId", "id")'
    );
    expect(sql).toContain('REFERENCES "users" ("organizationId", "id")');
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(
      /\b(?:SENT|QUEUED|providerMessageId|outbox|payload)\b/
    );
  });

  it('forces explicit tenant AND branch scope in both RLS checks', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(
      sql.match(
        /"organizationId" = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)/g
      )
    ).toHaveLength(2);
    expect(
      sql.match(/"branchId" = NULLIF\(current_setting\('app.current_branch_id', true\), ''\)/g)
    ).toHaveLength(2);
    expect(sql).not.toMatch(/current_branch_id.*IS NULL/);
  });

  it('requires decision evidence and prevents scope mutation, deletion or rewriting a terminal review', () => {
    expect(sql).toContain(
      '"status" = \'DRAFT\' AND "decidedByUserId" IS NULL AND "decidedAt" IS NULL'
    );
    expect(sql).toContain(
      '"status" IN (\'APPROVED\', \'SKIPPED\') AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL'
    );
    expect(sql).toContain("TG_OP = 'DELETE'");
    expect(sql).toContain('OLD."status" <> \'DRAFT\'');
    expect(sql).toContain("to_jsonb(NEW) - ARRAY['status', 'decidedByUserId', 'decidedAt']");
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).not.toMatch(/UPDATE\s+"pharmacy_refill_reminder_captures"/);
  });
});
