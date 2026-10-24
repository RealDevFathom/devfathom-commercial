import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const metrics = schema.match(/model CustomerMetrics \{([\s\S]*?)\n\}/)?.[1];
const sql = readFileSync(
  'prisma/migrations/20261024163000_customer_metrics_tenant_relation/migration.sql',
  'utf8'
);

describe('native CustomerMetrics defining-side tenant relation', () => {
  it('declares composite uniqueness on CustomerMetrics, not just its referenced customer', () => {
    expect(metrics).toContain('@@unique([organizationId, customerId])');
    expect(metrics).toContain('customerId String @id');
    expect(metrics).toContain(
      '@relation(fields: [organizationId, customerId], references: [organizationId, id], onDelete: Restrict)'
    );
  });

  it('materializes the inherited unmigrated table with matching tenant FK and unique index', () => {
    expect(sql).toContain('CREATE TABLE "customer_metrics"');
    expect(sql).toContain('PRIMARY KEY ("customerId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "customerId")');
    expect(sql).toContain('REFERENCES "pharmacy_customers" ("organizationId", "id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "customer_metrics_organizationId_customerId_key"');
    expect(sql).toContain('ON "customer_metrics" ("organizationId", "customerId")');
  });

  it('forces tenant isolation and does not rewrite any existing customer or consent data', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('WITH CHECK');
    expect(
      sql.match(
        /"organizationId" = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)/g
      )
    ).toHaveLength(2);
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(
      /\b(?:UPDATE\s+"|DELETE\s+FROM|TRUNCATE|DROP|DISABLE|INSERT\s+INTO)\b/i
    );
  });
});
