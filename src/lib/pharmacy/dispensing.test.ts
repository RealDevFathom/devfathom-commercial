import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertPharmacistApproved,
  assertPrescriptionSaleLineReady,
  assertSubstitutionRecorded,
  PharmacyDispensingError,
} from './dispensing';

function dbWith(options: { signed?: boolean; substitution?: boolean; prescription?: boolean } = {}) {
  const now = new Date('2026-10-22T12:00:00.000Z');
  return {
    pharmacyPharmacistReviewDecision: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.signed ? { id: 'decision', actorUserId: 'pharmacist-1' } : null),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyPharmacistReviewItem: {
      findFirst: vi.fn().mockResolvedValue(
        options.prescription
          ? {
              line: {
                medicineId: 'medicine-1',
                presentationId: 'presentation-1',
                authorizedCanonicalUnits: 20,
                fills: [],
                prescription: {
                  validFrom: new Date(now.getTime() - 1_000),
                  validUntil: new Date(now.getTime() + 1_000),
                },
              },
            }
          : null
      ),
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

  const saleLine = {
    id: 'sale-line-1',
    medicineId: 'medicine-1',
    presentationId: 'presentation-1',
    canonicalUnits: 10,
  };

  it('refuses an Rx-only line without a linked valid prescription', async () => {
    await expect(
      assertPrescriptionSaleLineReady(dbWith({ signed: true }), saleLine)
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_REQUIRED' });
  });

  it('refuses an Rx-only line without pharmacist approval', async () => {
    await expect(
      assertPrescriptionSaleLineReady(dbWith({ prescription: true }), saleLine)
    ).rejects.toMatchObject({ code: 'PHARMACIST_APPROVAL_REQUIRED' });
  });

  it('allows an Rx-only line with a valid linked prescription and pharmacist approval', async () => {
    await expect(
      assertPrescriptionSaleLineReady(dbWith({ prescription: true, signed: true }), saleLine)
    ).resolves.toBeUndefined();
  });

  it('does not treat a wildcard as an explicit pharmacist dispense grant', async () => {
    const db = dbWith({ prescription: true, signed: true });
    vi.mocked(db.user.findFirst).mockResolvedValue({
      organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    } as never);
    await expect(assertPrescriptionSaleLineReady(db, saleLine)).rejects.toMatchObject({
      code: 'PHARMACIST_APPROVAL_REQUIRED',
    });
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
