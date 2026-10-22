import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacyDispensingError extends Error {
  constructor(
    readonly code:
      | 'PRESCRIPTION_REQUIRED'
      | 'PHARMACIST_APPROVAL_REQUIRED'
      | 'SUBSTITUTION_RECORD_REQUIRED'
  ) {
    super(
      code === 'PRESCRIPTION_REQUIRED'
        ? 'A linked, valid prescription line is required.'
        : code === 'PHARMACIST_APPROVAL_REQUIRED'
        ? 'A signed pharmacist decision is required.'
        : 'A substitution record is required.'
    );
    this.name = 'PharmacyDispensingError';
  }
}

/** Server-side release gate for an Rx-only, non-controlled counter line. */
export async function assertPrescriptionSaleLineReady(
  db: ScopedDb,
  saleLine: {
    id: string;
    medicineId: string;
    presentationId: string;
    canonicalUnits: number;
    prescriptionLineId?: string;
  },
  now = new Date()
): Promise<void> {
  const review = await db.pharmacyPharmacistReviewItem.findFirst({
    where: { saleLineId: saleLine.id },
    include: {
      line: { include: { prescription: true, fills: { select: { quantityCanonicalUnits: true } } } },
    },
  });
  const line = review?.line;
  const alreadyFilled =
    line?.fills.reduce((total, fill) => total + fill.quantityCanonicalUnits, 0) ?? 0;
  if (
    !line ||
    (saleLine.prescriptionLineId !== undefined && line.id !== saleLine.prescriptionLineId) ||
    line.medicineId !== saleLine.medicineId ||
    line.presentationId !== saleLine.presentationId ||
    line.prescription.validFrom > now ||
    line.prescription.validUntil <= now ||
    line.authorizedCanonicalUnits - alreadyFilled < saleLine.canonicalUnits
  ) {
    throw new PharmacyDispensingError('PRESCRIPTION_REQUIRED');
  }
  await assertPharmacistApproved(db, saleLine.id);
}

/** Stable POS-A integration boundary: completion must call this for required lines. */
export async function assertPharmacistApproved(db: ScopedDb, saleLineId: string): Promise<void> {
  const signed = await db.pharmacyPharmacistReviewDecision.findFirst({
    where: { reviewItem: { saleLineId }, kind: 'SIGN', signedAt: { not: null } },
    select: { id: true, actorUserId: true },
  });
  if (!signed) throw new PharmacyDispensingError('PHARMACIST_APPROVAL_REQUIRED');
  const actor = await db.user.findFirst({
    where: { id: signed.actorUserId, status: 'ACTIVE' },
    select: {
      organizationRole: { select: { permissions: true } },
      permissionOverrides: {
        select: { capability: true, effect: true, expiresAt: true },
      },
    },
  });
  const now = new Date();
  const overrides = actor?.permissionOverrides.filter(
    (rule) => rule.expiresAt === null || rule.expiresAt > now
  );
  const roleRules = actor?.organizationRole?.permissions ?? [];
  const exactRole = roleRules.filter(
    (rule) => rule.capability === 'pharmacy:dispense'
  );
  const denied =
    overrides?.some(
      (rule) =>
        rule.effect === 'DENY' &&
        (rule.capability === 'pharmacy:dispense' ||
          rule.capability === 'pharmacy:*' ||
          rule.capability === '*')
    ) ||
    roleRules.some(
      (rule) =>
        rule.effect === 'DENY' &&
        (rule.capability === 'pharmacy:dispense' ||
          rule.capability === 'pharmacy:*' ||
          rule.capability === '*')
    );
  const allowed =
    overrides?.some(
      (rule) => rule.effect === 'ALLOW' && rule.capability === 'pharmacy:dispense'
    ) || exactRole.some((rule) => rule.effect === 'ALLOW');
  if (denied || !allowed) throw new PharmacyDispensingError('PHARMACIST_APPROVAL_REQUIRED');
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
