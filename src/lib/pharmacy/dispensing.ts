import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacyDispensingError extends Error {
  constructor(readonly code: 'PHARMACIST_APPROVAL_REQUIRED' | 'SUBSTITUTION_RECORD_REQUIRED') {
    super(
      code === 'PHARMACIST_APPROVAL_REQUIRED'
        ? 'A signed pharmacist decision is required.'
        : 'A substitution record is required.'
    );
    this.name = 'PharmacyDispensingError';
  }
}

/** Stable POS-A integration boundary: completion must call this for required lines. */
export async function assertPharmacistApproved(db: ScopedDb, saleLineId: string): Promise<void> {
  const signed = await db.pharmacyPharmacistReviewDecision.findFirst({
    where: { reviewItem: { saleLineId }, kind: 'SIGN', signedAt: { not: null } },
    select: { id: true },
  });
  if (!signed) throw new PharmacyDispensingError('PHARMACIST_APPROVAL_REQUIRED');
}

/** RX-04 sale-line mutation guard: same presentation is allowed; a change needs evidence. */
export async function assertSubstitutionRecorded(
  db: ScopedDb,
  input: { saleLineId: string; prescribedPresentationId: string; suppliedPresentationId: string }
): Promise<void> {
  if (input.prescribedPresentationId === input.suppliedPresentationId) return;
  const record = await db.pharmacySubstitutionRecord.findFirst({
    where: {
      saleLineId: input.saleLineId,
      prescribedPresentationId: input.prescribedPresentationId,
      suppliedPresentationId: input.suppliedPresentationId,
    },
    select: { id: true },
  });
  if (!record) throw new PharmacyDispensingError('SUBSTITUTION_RECORD_REQUIRED');
}
