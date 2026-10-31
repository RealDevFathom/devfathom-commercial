import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261101000000_pharmacy_customer_churn_scores/migration.sql'
  ),
  'utf8'
);
const code = sql.replace(/^\s*--.*$/gm, '');
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

describe('pharmacy churn scoring migration (#729)', () => {
  it('forces tenant and branch RLS on both new tables', () => {
    for (const table of ['pharmacy_customer_churn_scores', 'pharmacy_churn_scoring_runs'])
      expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('app.current_organization_id');
    expect(sql).toContain('app.current_branch_id');
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/i);
  });

  it('anchors scores to the tenant customer and branch with composite keys', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id")'
    );
    expect(sql).toContain(
      'FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id")'
    );
  });

  it('keeps one current score per customer and one run per branch business date', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "pharmacy_customer_churn_scores_customer_key" ON "pharmacy_customer_churn_scores"("organizationId", "branchId", "customerId")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "pharmacy_churn_scoring_runs_daily_key" ON "pharmacy_churn_scoring_runs"("organizationId", "branchId", "businessDate")'
    );
  });

  it('bounds the RFM values in the database', () => {
    expect(sql).toContain('"churnScore" BETWEEN 0 AND 100');
    expect(sql).toContain('"recencyScore" BETWEEN 1 AND 5');
    expect(sql).toContain('"riskBand" IN (\'LOW\', \'MEDIUM\', \'HIGH\')');
  });

  it('stores no clinical, identity or contact data', () => {
    expect(code).not.toMatch(/prescription|patient|medicine|allerg|diagnos|phone|displayName/i);
  });

  it('is additive only', () => {
    expect(code).not.toMatch(/\bDROP\b/);
    expect(code).not.toMatch(/ALTER TABLE "/);
    expect(schema).toContain('@@map("pharmacy_customer_churn_scores")');
    expect(schema).toContain('@@map("pharmacy_churn_scoring_runs")');
  });
});
