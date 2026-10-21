import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  activeLegalHoldKeys,
  assertControlledRegisterDeletable,
  assertPharmacyRecordDeletable,
  controlledRegisterRetainedUntil,
  PharmacyLegalHoldError,
  PharmacyRetentionError,
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

describe('controlled register 3-year retention (spec §3)', () => {
  it('runs retention from the later of the entry date and the last entry, min 3 years', () => {
    const entryAt = new Date('2026-01-01T00:00:00.000Z');
    const lastAt = new Date('2026-06-01T00:00:00.000Z');
    // Anchored on the later date (the last entry), plus three years.
    expect(controlledRegisterRetainedUntil(entryAt, lastAt).toISOString()).toBe(
      '2029-06-01T00:00:00.000Z'
    );
    // A shorter configured span is floored to the statutory three years.
    expect(controlledRegisterRetainedUntil(entryAt, lastAt, 1).toISOString()).toBe(
      '2029-06-01T00:00:00.000Z'
    );
    // A longer configured span is honoured.
    expect(controlledRegisterRetainedUntil(entryAt, lastAt, 5).toISOString()).toBe(
      '2031-06-01T00:00:00.000Z'
    );
  });

  function retentionDb(lastAt: Date) {
    return {
      pharmacyLegalHoldEvent: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyControlledRegisterEntry: {
        findFirst: vi.fn().mockResolvedValue({
          organizationId: 'org',
          branchId: 'branch',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        aggregate: vi.fn().mockResolvedValue({ _max: { createdAt: lastAt } }),
      },
    } as unknown as ScopedDb;
  }

  it('refuses deletion inside the retention window', async () => {
    const db = retentionDb(new Date('2026-06-01T00:00:00.000Z'));
    await expect(
      assertControlledRegisterDeletable(db, 'entry-1', new Date('2028-06-01T00:00:00.000Z'))
    ).rejects.toBeInstanceOf(PharmacyRetentionError);
  });

  it('permits deletion once the window has elapsed', async () => {
    const db = retentionDb(new Date('2026-06-01T00:00:00.000Z'));
    await expect(
      assertControlledRegisterDeletable(db, 'entry-1', new Date('2029-06-02T00:00:00.000Z'))
    ).resolves.toBeUndefined();
  });

  it('still refuses deletion while a legal hold is in force', async () => {
    const db = retentionDb(new Date('2026-06-01T00:00:00.000Z'));
    vi.mocked(db.pharmacyLegalHoldEvent.findMany).mockResolvedValue([
      { holdKey: 'case-a', kind: 'PLACED' },
    ] as never);
    await expect(
      assertControlledRegisterDeletable(db, 'entry-1', new Date('2030-01-01T00:00:00.000Z'))
    ).rejects.toBeInstanceOf(PharmacyLegalHoldError);
  });
});
