import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { activeLegalHoldKeys } from './retention';

describe('SAFE-04 legal hold', () => {
  it('reports any latest hold event that remains PLACED', async () => {
    const db = {
      pharmacyLegalHoldEvent: {
        findMany: vi.fn().mockResolvedValue([
          { holdKey: 'case-a', kind: 'PLACED' },
          { holdKey: 'case-b', kind: 'PLACED' },
          { holdKey: 'case-a', kind: 'RELEASED' },
        ]),
      },
    } as unknown as ScopedDb;
    await expect(activeLegalHoldKeys(db, 'PRESCRIPTION', 'rx-1')).resolves.toEqual(['case-b']);
  });

  it('clears holds after every hold is released without waiving retention', async () => {
    const db = {
      pharmacyLegalHoldEvent: {
        findMany: vi.fn().mockResolvedValue([
          { holdKey: 'case-a', kind: 'PLACED' },
          { holdKey: 'case-a', kind: 'RELEASED' },
        ]),
      },
    } as unknown as ScopedDb;
    await expect(activeLegalHoldKeys(db, 'AUDIT', 'audit-1')).resolves.toEqual([]);
  });
});
