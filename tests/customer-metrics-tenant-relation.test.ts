import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const metrics = schema.match(/model CustomerMetrics \{([\s\S]*?)\n\}/)?.[1] ?? '';
const normalized = metrics.replace(/[ \t]+/g, ' ');
const sql = readFileSync('prisma/migrations/20261021110000_growth_foundation/migration.sql', 'utf8');
const metricsPolicy =
  sql.match(/CREATE POLICY "customer_metrics_tenant_isolation"[\s\S]*?;/)?.[0] ?? '';

describe('native CustomerMetrics defining-side tenant relation', () => {
  it('declares composite uniqueness on CustomerMetrics, not just its referenced customer', () => {
    expect(schema.match(/^model CustomerMetrics \{/gm)).toHaveLength(1);
    expect(normalized).toContain('@@unique([organizationId, customerId])');
    expect(normalized).toContain('customerId String @id');
    expect(normalized).toContain(
      '@relation(fields: [organizationId, customerId], references: [organizationId, id], onDelete: Restrict)'
    );
  });

  it('relies on the single base growth migration for the table, tenant FK and unique index', () => {
    expect(
      existsSync('prisma/migrations/20261024163000_customer_metrics_tenant_relation')
    ).toBe(false);
    expect(sql.match(/CREATE TABLE "customer_metrics"/g)).toHaveLength(1);
    expect(sql).toContain('PRIMARY KEY ("customerId")');
    expect(sql).toContain(
      'ADD CONSTRAINT "customer_metrics_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "customer_metrics_organizationId_customerId_key" ON "customer_metrics"("organizationId", "customerId")'
    );
  });

  it('forces tenant isolation on customer_metrics with a USING and WITH CHECK predicate', () => {
    expect(sql).toContain('ALTER TABLE "customer_metrics" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "customer_metrics" FORCE ROW LEVEL SECURITY');
    expect(metricsPolicy).toContain('WITH CHECK');
    expect(
      metricsPolicy.match(
        /"organizationId" = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)/g
      )
    ).toHaveLength(2);
  });
});
