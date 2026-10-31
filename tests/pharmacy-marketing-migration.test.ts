import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260904196000_pharmacy_permissioned_marketing/migration.sql'
  ),
  'utf8'
);
const voucherSql = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261029000182_pharmacy_voucher_scoping/migration.sql'),
  'utf8'
);
const voucherLifecycleSql = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261031000182_pharmacy_voucher_lifecycle/migration.sql'),
  'utf8'
);

describe('pharmacy permissioned marketing migration', () => {
  it('stores segment definitions as auditable data and rejects clinical keys in the database', () => {
    expect(sql).toContain('"definition" JSONB NOT NULL');
    expect(sql).toMatch(
      /CHECK \("definition"::text !~\* '\(prescription\|condition\|allerg\|medicine/
    );
  });

  it('forces tenant and branch RLS on every new table', () => {
    const tables = [
      'pharmacy_marketing_segments',
      'pharmacy_marketing_templates',
      'pharmacy_campaigns',
      'pharmacy_campaign_captures',
      'pharmacy_campaign_exclusions',
      'pharmacy_campaign_attributions',
    ];
    for (const table of tables) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('app.current_branch_id');
  });

  it('has no delivery/provider state and fails regulated campaigns closed', () => {
    expect(sql).not.toMatch(/provider|deliveredAt|sentAt/);
    expect(sql).toContain(
      'CHECK (NOT "promotesRegulatedItem" OR "status" IN (\'DRAFT\', \'REFUSED\'))'
    );
  });
});

describe('pharmacy voucher migration', () => {
  it('keeps populated campaign tables compatible and validates constraints in stages', () => {
    expect(voucherSql).toContain('ADD COLUMN "voucherEnabled" BOOLEAN DEFAULT false');
    expect(voucherSql).toContain('NOT VALID');
    expect(voucherSql).toContain('VALIDATE CONSTRAINT "pharmacy_campaign_voucher_columns_nn_ck"');
    expect(voucherSql.indexOf('NOT VALID')).toBeLessThan(voucherSql.indexOf('SET NOT NULL'));
  });

  it('persists a tenant-isolated capture-to-sale-line redemption', () => {
    expect(voucherSql).toContain('CREATE TABLE "pharmacy_voucher_redemptions"');
    expect(voucherSql).toContain('REFERENCES "pharmacy_sale_lines"');
    expect(voucherSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(voucherSql).toContain('app.current_branch_id');
  });

  it('replaces lifetime uniqueness with an append-only reservation guard and unpaid-void release', () => {
    expect(voucherSql).toContain('UNIQUE ("organizationId", "captureId")');
    expect(voucherLifecycleSql).toContain(
      'DROP CONSTRAINT "pharmacy_voucher_redemptions_organizationId_captureId_key"'
    );
    expect(voucherLifecycleSql).toContain(
      'CREATE INDEX "pharmacy_voucher_redemptions_organizationId_captureId_idx"'
    );
    expect(voucherLifecycleSql).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_voucher_redemptions"');
    expect(voucherLifecycleSql).toContain('CREATE TRIGGER pharmacy_voucher_claim_capture_guard');
    expect(voucherLifecycleSql).toContain('FOR UPDATE');
    expect(voucherLifecycleSql).toContain("s.status = 'VOID'");
    expect(voucherLifecycleSql).toContain('NOT EXISTS (SELECT 1 FROM pharmacy_tenders t');
    expect(voucherLifecycleSql).toContain("e.kind = 'VOIDED'");
    expect(voucherLifecycleSql).toContain("CONSTRAINT = 'pharmacy_voucher_capture_active_key'");
  });
});
