import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  activeLegalHoldKeys,
  assertPharmacyRecordDeletable,
  PharmacyLegalHoldError,
} from './retention';

describe('SAFE-04 legal hold', () => {
  it('refuses deletion while any latest hold event remains PLACED', async () => {
    const db = {
      pharmacyLegalHoldEvent: {
        findMany: vi.fn().mockResolvedValue([
          { holdKey: 'case-a', kind: 'PLACED' },
          { holdKey: 'case-b', kind: 'PLACED' },
          { holdKey: 'case-a', kind: 'RELEASED' },
        ]),
      },
    } as unknown as ScopedDb;
    await expect(assertPharmacyRecordDeletable(db, 'PRESCRIPTION', 'rx-1')).rejects.toEqual(
      new PharmacyLegalHoldError(['case-b'])
    );
  });

  it('permits deletion after every hold is released', async () => {
    const db = {
      pharmacyLegalHoldEvent: {
        findMany: vi.fn().mockResolvedValue([
          { holdKey: 'case-a', kind: 'PLACED' },
          { holdKey: 'case-a', kind: 'RELEASED' },
        ]),
      },
    } as unknown as ScopedDb;
    await expect(activeLegalHoldKeys(db, 'AUDIT', 'audit-1')).resolves.toEqual([]);
    await expect(assertPharmacyRecordDeletable(db, 'AUDIT', 'audit-1')).resolves.toBeUndefined();
  });
});
