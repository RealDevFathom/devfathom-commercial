import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertPharmacistApproved,
  assertSubstitutionRecorded,
  PharmacyDispensingError,
} from './dispensing';

function dbWith(options: { signed?: boolean; substitution?: boolean }) {
  return {
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn().mockResolvedValue(options.signed ? { id: 'decision' } : null),
    },
    pharmacySubstitutionRecord: {
      findFirst: vi.fn().mockResolvedValue(options.substitution ? { id: 'substitution' } : null),
    },
  } as unknown as ScopedDb;
}

describe('RX-03 pharmacist sale-completion guard', () => {
  it('refuses a pharmacist-required sale line without a signed decision', async () => {
    await expect(assertPharmacistApproved(dbWith({}), 'sale-line-1')).rejects.toMatchObject({
      code: 'PHARMACIST_APPROVAL_REQUIRED',
    } satisfies Partial<PharmacyDispensingError>);
  });
  it('accepts a signed pharmacist decision', async () => {
    await expect(
      assertPharmacistApproved(dbWith({ signed: true }), 'sale-line-1')
    ).resolves.toBeUndefined();
  });
});

describe('RX-04 non-silent substitution guard', () => {
  it('refuses a changed presentation without substitution evidence', async () => {
    await expect(
      assertSubstitutionRecorded(dbWith({}), {
        saleLineId: 'sale-line-1',
        prescribedPresentationId: 'p1',
        suppliedPresentationId: 'p2',
      })
    ).rejects.toMatchObject({
      code: 'SUBSTITUTION_RECORD_REQUIRED',
    } satisfies Partial<PharmacyDispensingError>);
  });
  it('allows unchanged presentation without querying evidence', async () => {
    const db = dbWith({});
    await assertSubstitutionRecorded(db, {
      saleLineId: 'sale-line-1',
      prescribedPresentationId: 'p1',
      suppliedPresentationId: 'p1',
    });
    expect(db.pharmacySubstitutionRecord.findFirst).not.toHaveBeenCalled();
  });
});
