import { describe, expect, it, vi } from 'vitest';

import {
  recordCompletedPrescriptionReference,
  resolvePrescriptionReference,
} from './rx-prescription-reference';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'pharmacist-1' };
const prescription = {
  patientId: 'patient-1',
  validFrom: new Date('2026-10-01T00:00:00.000Z'),
  validUntil: new Date('2026-10-22T00:00:00.000Z'),
  authorizedRepeats: 1,
};

function referenceDb() {
  const organization = { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) };
  return {
    organization,
    db: {
      $queryRaw: vi.fn(async () => []),
      organization,
      prescriptionLine: {
        findFirst: vi.fn(async () => ({
          id: 'line-1',
          authorizedCanonicalUnits: 20,
          prescription,
          fills: [],
        })),
      },
      pharmacySale: {
        findFirst: vi.fn(async () => ({ customer: { patientId: 'patient-1' } })),
      },
      prescriptionFill: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'fill-1' })),
      },
    },
  };
}

describe('prescription reference organization calendar gates', () => {
  it('loads the organization zone when attaching a reference and includes its valid-through day', async () => {
    const { db, organization } = referenceDb();

    await expect(
      resolvePrescriptionReference(
        db as never,
        scope,
        {
          saleId: 'sale-1',
          medicineId: 'medicine-1',
          presentationId: 'presentation-1',
          prescriptionLineId: 'line-1',
          patientId: 'patient-1',
          units: 10,
        },
        new Date('2026-10-22T18:59:59.999Z')
      )
    ).resolves.toEqual({ prescriptionLineId: 'line-1', patientId: 'patient-1' });
    expect(organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
  });

  it('loads the organization zone again at completion and rejects the next local day', async () => {
    const { db, organization } = referenceDb();

    await expect(
      recordCompletedPrescriptionReference(
        db as never,
        scope,
        {
          id: 'sale-line-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          medicineId: 'medicine-1',
          presentationId: 'presentation-1',
          canonicalUnits: 10,
          prescriptionLineId: 'line-1',
          prescriptionPatientId: 'patient-1',
          saleId: 'sale-1',
        },
        new Date('2026-10-22T19:00:00.000Z')
      )
    ).rejects.toMatchObject({ reason: 'PRESCRIPTION_NOT_IN_DATE' });
    expect(organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
    expect(db.prescriptionFill.create).not.toHaveBeenCalled();
  });
});
