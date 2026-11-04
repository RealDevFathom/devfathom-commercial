import { describe, expect, it, vi } from 'vitest';

import { recordCompletedPrescriptionReference } from './rx-prescription-reference';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const input = {
  id: 'line-a',
  organizationId: scope.organizationId,
  branchId: scope.branchId,
  medicineId: 'otc-medicine',
  presentationId: 'presentation-a',
  canonicalUnits: 10,
  prescriptionLineId: 'prescription-line-a',
  prescriptionPatientId: 'patient-a',
  saleId: 'sale-a',
};

function fixture(permissions: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>) {
  return {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions },
        permissionOverrides: [],
      })),
    },
    $queryRaw: vi.fn(async () => []),
    pharmacySale: {
      findFirst: vi.fn(async () => ({ customer: { patientId: 'patient-a' } })),
    },
    prescriptionLine: {
      findFirst: vi.fn(async () => ({
        authorizedCanonicalUnits: 10,
        prescription: {
          patientId: 'patient-a',
          validFrom: new Date('2020-01-01'),
          validUntil: new Date('2100-01-01'),
          authorizedRepeats: 0,
        },
        fills: [],
      })),
    },
    prescriptionFill: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
    },
  };
}

describe('authorization of the actor recorded on a completed prescription fill', () => {
  it.each([
    { actor: 'cashier', permissions: [] },
    { actor: 'wildcard', permissions: [{ capability: 'pharmacy:*', effect: 'ALLOW' as const }] },
    {
      actor: 'denied pharmacist',
      permissions: [
        { capability: 'pharmacy:dispense', effect: 'ALLOW' as const },
        { capability: 'pharmacy:dispense', effect: 'DENY' as const },
      ],
    },
  ])('refuses a $actor', async ({ permissions }) => {
    const db = fixture(permissions);
    await expect(
      recordCompletedPrescriptionReference(db as never, scope, input)
    ).rejects.toMatchObject({ reason: 'PRESCRIPTION_NEEDS_PHARMACIST' });
    expect(db.prescriptionFill.create).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('records the authorized completing pharmacist and preserves idempotency', async () => {
    const db = fixture([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]);
    await recordCompletedPrescriptionReference(db as never, scope, input);
    expect(db.prescriptionFill.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        organizationId: scope.organizationId,
        prescriptionLineId: input.prescriptionLineId,
        fillSequence: 1,
        quantityCanonicalUnits: 10,
        dispensedByUserId: scope.actorId,
        idempotencyKey: 'rx-reference:line-a',
      },
    });
    db.prescriptionFill.findUnique.mockResolvedValueOnce({ id: 'fill-a' } as never);
    await recordCompletedPrescriptionReference(db as never, scope, input);
    expect(db.prescriptionFill.create).toHaveBeenCalledTimes(1);
  });
});
