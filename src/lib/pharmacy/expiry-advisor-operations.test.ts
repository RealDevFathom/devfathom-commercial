import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('./supplier-returns-operations', () => ({ createPurchaseReturn: vi.fn() }));

import { readExpiryAdvice } from './expiry-advisor-operations';

const AT = new Date('2026-09-02T09:00:00.000Z');

function capture() {
  const queryRaw = vi.fn().mockResolvedValue([]);
  return { db: { $queryRaw: queryRaw } as unknown as ScopedDb, queryRaw };
}

/**
 * #1042 / DEV-581. The database suite proves the outer predicates exclude other
 * tenants' and branches' rows; it cannot see the CTE predicates, because their
 * rows only ever join on globally unique lot and branch ids. This pins them.
 */
describe('expiry advisor query scope', () => {
  it('binds the tenant and branches as parameters in every CTE and the outer query', async () => {
    const { db, queryRaw } = capture();
    await readExpiryAdvice(
      db,
      { organizationId: 'org_scope_1', branchIds: ['branch_scope_1', 'branch_scope_2'] },
      AT
    );
    const sql = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    // branch_history (s), sold (a), available (balance), source (line), outer (lot).
    for (const alias of ['s', 'a', 'balance', 'line', 'lot']) {
      expect(sql.text).toMatch(new RegExp(`\\b${alias}\\."organizationId"=\\$\\d+`));
      expect(sql.text).toMatch(new RegExp(`\\b${alias}\\."branchId" IN \\(\\$\\d+,\\$\\d+\\)`));
    }
    expect(sql.values.filter((value) => value === 'org_scope_1')).toHaveLength(5);
    expect(sql.values.filter((value) => value === 'branch_scope_1')).toHaveLength(5);
    expect(sql.values.filter((value) => value === 'branch_scope_2')).toHaveLength(5);
    expect(sql.text).not.toMatch(/org_scope_1|branch_scope_/);
    expect(sql.text).toContain('JOIN "pharmacy_medicines" medicine');
    expect(sql.text).toContain('medicine."productName" AS "medicineName"');
  });

  it('narrows the advised lots to the selected supplier, ingredient and batch (DEV-256)', async () => {
    const { db, queryRaw } = capture();
    await readExpiryAdvice(
      db,
      {
        organizationId: 'org_scope_1',
        branchIds: ['branch_scope_1'],
        supplierId: 'sup_1',
        ingredientId: 'ing_1',
        batchId: 'batch_1',
      },
      AT
    );
    const sql = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(sql.text).toMatch(/lot\."manufacturingBatchId"=\$\d+/);
    expect(sql.text).toContain('dim_ingredient."ingredientId"=');
    expect(sql.text).toContain('dim_ingredient."medicineId"=dim_batch."medicineId"');
    expect(sql.text).toContain('dim_receipt."supplierId"=');
    expect(sql.text).toContain('dim_supplier."name"=lot."supplierName"');
    expect(sql.values).toContain('batch_1');
    expect(sql.values).toContain('ing_1');
    expect(sql.values.filter((value) => value === 'sup_1')).toHaveLength(2);

    queryRaw.mockClear();
    await readExpiryAdvice(db, { organizationId: 'org_scope_1', branchIds: ['branch_scope_1'] }, AT);
    const unfiltered = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(unfiltered.text).not.toContain('dim_');
  });

  it('refuses a missing tenant and reads nothing for an empty branch scope', async () => {
    const { db, queryRaw } = capture();
    await expect(
      readExpiryAdvice(db, { organizationId: '', branchIds: ['branch_scope_1'] }, AT)
    ).rejects.toThrow('EXPIRY_ADVISOR_SCOPE_REQUIRED');
    await expect(
      readExpiryAdvice(db, { organizationId: 'org_scope_1', branchIds: [] }, AT)
    ).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
