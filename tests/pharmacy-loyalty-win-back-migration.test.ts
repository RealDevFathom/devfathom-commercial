import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261023133001_pharmacy_loyalty_win_back/migration.sql',
  'utf8'
);

const tenantTables = [
  'pharmacy_win_back_tiers',
  'pharmacy_win_back_category_margins',
  'pharmacy_win_back_previews',
  'pharmacy_win_back_issuances',
];

describe('pharmacy loyalty win-back migration contract', () => {
  it('stores every money amount as constrained integer paisa', () => {
    for (const column of [
      'winBackMinimumSpendMinor',
      'winBackMinNextBasketMinor',
      'minimumSpendMinor',
      'voucherValueMinor',
      'totalVoucherLiabilityMinor',
      'expectedVoucherCostMinor',
      'expectedMarginMinor',
      'netMarginImpactMinor',
    ]) expect(sql).toMatch(new RegExp(`"${column}" INTEGER`));
    expect(sql).toContain('CHECK ("winBackMinimumSpendMinor" BETWEEN 0 AND 2147483647)');
    expect(sql).toContain('CHECK ("voucherValueMinor" BETWEEN 20000 AND 100000)');
  });

  it('uses tenant-composite identities for references and concurrent issuance claims', () => {
    expect(sql).toContain('UNIQUE ("organizationId", "customerId", "campaignWindowStart")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "customerId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "branchId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "voucherId")');
  });

  it('defaults every new row to the session tenant and forces the shared RLS predicate', () => {
    for (const table of tenantTables) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql.match(/DEFAULT current_setting\('app\.current_organization_id', true\)/g))
      .toHaveLength(tenantTables.length);
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain(
      `USING ("organizationId" = current_setting(''app.current_organization_id'', true)) ` +
      `WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))`
    );
  });
});
