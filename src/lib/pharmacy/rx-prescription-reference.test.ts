import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  assertRxLinesPrescribed,
  PharmacyRxReferenceError,
  recordCompletedPrescriptionReference,
  resolvePrescriptionReference,
} from './rx-prescription-reference';

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const VALID_DAY = new Date('2026-10-22T00:00:00.000Z');

function referenceDb(timezone: string | null) {
  const db = {
    $queryRaw: vi.fn(),
    prescriptionLine: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'rx_line',
        authorizedCanonicalUnits: 30,
        prescription: {
          patientId: 'patient-a',
          validFrom: VALID_DAY,
          validUntil: VALID_DAY,
          authorizedRepeats: 1,
        },
        fills: [],
      }),
    },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customer: null }) },
    prescriptionFill: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone }) },
  };
  return { db, scoped: db as unknown as ScopedDb };
}

// #526: a prescription valid on 22 Oct is current for the whole of 22 Oct in the organization's
// timezone, not from 00:00 UTC to 00:00 UTC. An unset or unknown zone falls back to UTC.
const CASES: Array<[timezone: string | null, now: string, current: boolean]> = [
  ['Asia/Karachi', '2026-10-21T18:59:59.999Z', false],
  ['Asia/Karachi', '2026-10-21T19:00:00.000Z', true],
  ['Asia/Karachi', '2026-10-22T18:59:59.999Z', true],
  ['Asia/Karachi', '2026-10-22T19:00:00.000Z', false],
  ['America/Los_Angeles', '2026-10-23T06:59:59.999Z', true],
  ['America/Los_Angeles', '2026-10-23T07:00:00.000Z', false],
  [null, '2026-10-23T00:00:00.000Z', false],
  ['PKT', '2026-10-23T00:00:00.000Z', false],
];

describe('prescription reference validity in the organization timezone', () => {
  it.each(CASES)('resolve under %s at %s is current: %s', async (timezone, now, current) => {
    const { db, scoped } = referenceDb(timezone);
    const result = resolvePrescriptionReference(
      scoped,
      SCOPE,
      {
        prescriptionLineId: 'rx_line',
        patientId: 'patient-a',
        saleId: 'sale',
        medicineId: 'med',
        presentationId: 'pres',
        units: 10,
      },
      new Date(now)
    );
    if (current)
      await expect(result).resolves.toEqual({
        prescriptionLineId: 'rx_line',
        patientId: 'patient-a',
      });
    else await expect(result).rejects.toMatchObject({ reason: 'PRESCRIPTION_NOT_IN_DATE' });
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: SCOPE.organizationId },
      select: { timezone: true },
    });
  });

  it.each(CASES)('completion under %s at %s is current: %s', async (timezone, now, current) => {
    const { db, scoped } = referenceDb(timezone);
    const result = recordCompletedPrescriptionReference(
      scoped,
      SCOPE,
      {
        id: 'sale_line',
        organizationId: SCOPE.organizationId,
        branchId: SCOPE.branchId,
        medicineId: 'med',
        presentationId: 'pres',
        canonicalUnits: 10,
        prescriptionLineId: 'rx_line',
        prescriptionPatientId: 'patient-a',
        saleId: 'sale',
      },
      new Date(now)
    );
    if (current) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toMatchObject({ reason: 'PRESCRIPTION_NOT_IN_DATE' });
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: SCOPE.organizationId },
      select: { timezone: true },
    });
    expect(db.prescriptionFill.create).toHaveBeenCalledTimes(current ? 1 : 0);
  });
});

describe('assertRxLinesPrescribed (DEV-629)', () => {
  const otc = { rx: false, restricted: false, controlled: false };
  const reviewDb = (signed: boolean) => {
    const findFirst = vi.fn().mockResolvedValue(signed ? { id: 'decision-1' } : null);
    return {
      db: {
        pharmacyPharmacistReviewDecision: { findFirst },
        pharmacyControlledRegisterEntry: {
          findFirst: vi.fn().mockResolvedValue(null),
          count: vi.fn().mockResolvedValue(1),
        },
      } as unknown as ScopedDb,
      findFirst,
    };
  };

  it.each([
    ['prescription-only', { ...otc, rx: true }],
    ['restricted', { ...otc, restricted: true }],
  ])('refuses a %s line with no prescription reference', async (_label, medicine) => {
    const { db, findFirst } = reviewDb(true);
    await expect(
      assertRxLinesPrescribed(db, [
        { id: 'otc-line', prescriptionLineId: null, medicine: otc },
        { id: 'rx-line', prescriptionLineId: null, medicine },
      ])
    ).rejects.toMatchObject({
      name: 'PharmacyRxReferenceError',
      reason: 'PRESCRIPTION_REQUIRED',
    } satisfies Partial<PharmacyRxReferenceError>);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses an attached prescription that no pharmacist has signed for this sale line', async () => {
    const { db, findFirst } = reviewDb(false);
    await expect(
      assertRxLinesPrescribed(db, [
        { id: 'rx-line', prescriptionLineId: 'rx_line', medicine: { ...otc, rx: true } },
      ])
    ).rejects.toMatchObject({
      name: 'PharmacyDispensingError',
      code: 'PHARMACIST_APPROVAL_REQUIRED',
    });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { reviewItem: { saleLineId: 'rx-line' }, kind: 'SIGN', signedAt: { not: null } },
      select: { id: true },
    });
  });

  it('admits signed Rx lines, OTC lines and controlled lines (which keep their register gate)', async () => {
    const { db, findFirst } = reviewDb(true);
    await expect(
      assertRxLinesPrescribed(db, [
        { id: 'rx-line', prescriptionLineId: 'rx_line', medicine: { ...otc, rx: true } },
        { id: 'otc-line', prescriptionLineId: null, medicine: otc },
        {
          id: 'controlled-line',
          allocations: [{ stockMovementId: 'controlled-movement' }],
          prescriptionLineId: null,
          medicine: { ...otc, rx: true, controlled: true },
        },
      ])
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledOnce();
  });
});
