import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20260904192000_pharmacy_supplier_action_links/migration.sql',
  'utf8'
);
const tables = [
  'pharmacy_supplier_relationships',
  'pharmacy_supplier_action_links',
  'pharmacy_supplier_submissions',
  'pharmacy_supplier_documents',
  'pharmacy_supplier_submission_approvals',
];

describe('SUP-01 supplier link migration security contract', () => {
  it('forces tenant and branch RLS on every new table', () => {
    for (const table of tables) {
      expect(sql).toContain(`'${table}'`);
      expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    }
    expect(sql).toContain('app.current_branch_id');
  });
  it('pins one relationship/PO pair and refuses mismatches (invariant 24)', () => {
    expect(sql).toContain('UNIQUE ("organizationId","supplierRelationshipId","purchaseOrderId")');
    expect(sql).toContain('supplier link relationship/order mismatch');
  });
  it('makes proposals, documents, and pharmacy decisions append-only and separate (25-27)', () => {
    expect(sql).toContain('pharmacy_supplier_submission_append_only');
    expect(sql).toContain('pharmacy_supplier_document_append_only');
    expect(sql).toContain('pharmacy_supplier_submission_approvals');
    expect(sql).toContain('supplier correction chain mismatch');
  });
  it('fails closed on upload type, size, malware verdict, and identity mismatch (28)', () => {
    expect(sql).toContain('"byteSize" > 0 AND "byteSize" <= 10485760');
    expect(sql).toContain("'application/pdf','image/png','image/jpeg'");
    expect(sql).toContain('"malwareChecked" = true');
    expect(sql).toContain('supplier submission link mismatch');
  });
});
