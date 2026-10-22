import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./migration.sql', import.meta.url), 'utf8');

describe('hotel folio ledger migration', () => {
  it('establishes the org and branch catalog key before the folio entry FK', () => {
    const unique = sql.indexOf('hotel_extras_org_branch_id_key');
    const entries = sql.indexOf('CREATE TABLE IF NOT EXISTS hotel_folio_entries');
    expect(unique).toBeGreaterThan(-1);
    expect(unique).toBeLessThan(entries);
  });
  it('forces RLS and scopes both USING and WITH CHECK by organization and property assignment', () => {
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(sql).toContain('hotel_folios."organizationId"');
    expect(sql).toContain('hotel_folios."branchId"');
    expect(sql).toContain('hotel_folio_entries."organizationId"');
    expect(sql).toContain('hotel_folio_entries."branchId"');
    expect(sql.match(/WITH CHECK/g)).toHaveLength(2);
  });

  it('blocks mutation and scopes the reversal source in its WHERE clause', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON hotel_folio_entries/);
    expect(sql).toContain("immutable; post a reversal");
    expect(sql).toMatch(/WHERE e\.id = p_entry_id[\s\S]*e\."organizationId" = p_organization_id[\s\S]*e\."branchId" = p_branch_id/);
  });
});
