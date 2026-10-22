import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  allocatePharmacyReceiptPrintCopy,
  PharmacyReceiptPrintError,
} from './receipt-print';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

function database(queryResults: unknown[][]) {
  const query = vi.fn();
  for (const result of queryResults) query.mockResolvedValueOnce(result);
  const tx = { $queryRawUnsafe: query };
  const db = {
    $transaction: vi.fn(async (run: (value: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { db: db as unknown as ScopedDb, query };
}

const scope = { organizationId: 'org-a', branchId: 'branch-a' };

describe('allocatePharmacyReceiptPrintCopy', () => {
  it.each([
    [1, false],
    [2, true],
    [17, true],
  ])('derives the marker from durable copy number %i', async (copyNumber, reprint) => {
    const { db, query } = database([[{ id: 'sale-a' }], [{ copyNumber }]]);

    await expect(
      allocatePharmacyReceiptPrintCopy(db, scope, 'sale-a', 'user-a', 'en')
    ).resolves.toEqual({ copyNumber, reprint });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0]?.slice(1)).toEqual(['org-a', 'branch-a', 'sale-a']);
    expect(query.mock.calls[1]?.slice(1)).toEqual([
      'org-a',
      'branch-a',
      'sale-a',
      'user-a',
      'en',
    ]);
  });

  it('refuses to allocate a copy unless the tenant sale is settled and numbered', async () => {
    const { db, query } = database([[]]);
    await expect(
      allocatePharmacyReceiptPrintCopy(db, scope, 'sale-a', 'user-a', 'en')
    ).rejects.toBeInstanceOf(PharmacyReceiptPrintError);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
