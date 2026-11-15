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

  it.each([
    ['prescription-only', { ...otc, rx: true }],
    ['restricted', { ...otc, restricted: true }],
  ])('refuses a %s line with no prescription reference', (_label, medicine) => {
    expect(() =>
      assertRxLinesPrescribed([
        { prescriptionLineId: null, medicine: otc },
        { prescriptionLineId: null, medicine },
      ])
    ).toThrowError(
      expect.objectContaining({
        name: 'PharmacyRxReferenceError',
        reason: 'PRESCRIPTION_REQUIRED',
      }) as PharmacyRxReferenceError
    );
  });

  it('admits referenced Rx lines, OTC lines and controlled lines (which keep their register gate)', () => {
    expect(() =>
      assertRxLinesPrescribed([
        { prescriptionLineId: 'rx_line', medicine: { ...otc, rx: true } },
        { prescriptionLineId: null, medicine: otc },
        { prescriptionLineId: null, medicine: { ...otc, rx: true, controlled: true } },
      ])
    ).not.toThrow();
  });
});
