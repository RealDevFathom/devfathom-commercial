import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'prisma/migrations/20261101000727_pharmacy_promotions/migration.sql',
  'utf8'
);
describe('#727 additive pharmacy promotions migration', () => {
  it('keeps tenant/branch isolation and composite foreign keys in the database', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
    expect(sql).toContain('WITH CHECK');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "medicineId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "branchId", "promotionId")');
  });
  it('uses nullable sale snapshots and checks rules without rewriting historical sales', () => {
    expect(sql).toContain('ADD COLUMN "promotionId" TEXT,');
    expect(sql).toContain('ADD COLUMN "promotionName" TEXT,');
    expect(sql).toContain('"effectiveFrom" < "effectiveTo"');
    expect(sql).toContain('BETWEEN 1 AND 10000');
    expect(sql).toContain('pharmacy_promotion_immutable BEFORE UPDATE');
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|POLICY)|TRUNCATE|UPDATE "pharmacy_sale_lines"/i);
  });
});
