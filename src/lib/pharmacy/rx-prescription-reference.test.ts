import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  assertVerifiedPrescriptionRelease,
  PharmacyRxReferenceError,
} from './rx-prescription-reference';

const medicine = (
  flags: Partial<{ rx: boolean; restricted: boolean; controlled: boolean }> = {}
) => ({ rx: false, restricted: false, controlled: false, ...flags });

function dbWithSignedDecision(signed: boolean) {
  return {
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn().mockResolvedValue(signed ? { id: 'signed-decision' } : null),
    },
  } as unknown as ScopedDb;
}

describe('DEV-629 server-side prescription release gate', () => {
  it.each([{ rx: true }, { restricted: true }])(
    'refuses a regulated line with no attached prescription (%o)',
    async (flags) => {
      const db = dbWithSignedDecision(true);
      await expect(
        assertVerifiedPrescriptionRelease(db, [
          { id: 'sale-line', prescriptionLineId: null, medicine: medicine(flags) },
        ])
      ).rejects.toMatchObject({
        reason: 'PRESCRIPTION_REQUIRED',
      } satisfies Partial<PharmacyRxReferenceError>);
      expect(db.pharmacyPharmacistReviewDecision.findFirst).not.toHaveBeenCalled();
    }
  );

  it('refuses an attached prescription that has not been signed for this sale line', async () => {
    const db = dbWithSignedDecision(false);
    await expect(
      assertVerifiedPrescriptionRelease(db, [
        { id: 'sale-line', prescriptionLineId: 'rx-line', medicine: medicine({ rx: true }) },
      ])
    ).rejects.toMatchObject({
      reason: 'PRESCRIPTION_NOT_VERIFIED',
    } satisfies Partial<PharmacyRxReferenceError>);
    expect(db.pharmacyPharmacistReviewDecision.findFirst).toHaveBeenCalledWith({
      where: {
        reviewItem: { saleLineId: 'sale-line', prescriptionLineId: 'rx-line' },
        kind: 'SIGN',
        signedAt: { not: null },
      },
      select: { id: true },
    });
  });

  it('accepts a signed prescription and leaves OTC and controlled emergency paths alone', async () => {
    const db = dbWithSignedDecision(true);
    await expect(
      assertVerifiedPrescriptionRelease(db, [
        {
          id: 'rx-line',
          prescriptionLineId: 'prescription-line',
          medicine: medicine({ rx: true }),
        },
        { id: 'otc-line', prescriptionLineId: null, medicine: medicine() },
        {
          id: 'emergency-line',
          prescriptionLineId: null,
          medicine: medicine({ rx: true, controlled: true }),
        },
      ])
    ).resolves.toBeUndefined();
    expect(db.pharmacyPharmacistReviewDecision.findFirst).toHaveBeenCalledTimes(1);
  });
});
