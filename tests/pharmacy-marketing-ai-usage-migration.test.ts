import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261023143017_pharmacy_marketing_ai_usage/migration.sql',
  'utf8'
);

describe('pharmacy marketing AI usage migration', () => {
  it('makes organization and branch mandatory and applies RLS to both durable rows', () => {
    expect(sql.match(/"organizationId" TEXT NOT NULL/g)).toHaveLength(2);
    expect(sql.match(/"branchId" TEXT NOT NULL/g)).toHaveLength(2);
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(sql.match(/current_branch_id/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('has tenant-scoped uniqueness for both charge reservation and usage recording', () => {
    expect(sql).toContain(
      'ON "pharmacy_marketing_ai_generations"("organizationId", "branchId", "idempotencyKey")'
    );
    expect(sql).toContain(
      'ON "pharmacy_marketing_ai_usage"("organizationId", "generationId")'
    );
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY/g)).toHaveLength(5);
  });
});
