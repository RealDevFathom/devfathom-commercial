import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import {
  captureRefillReminder,
  deriveRefillSchedule,
  dosesPerDayFromDirections,
  RefillSupportError,
} from './refill-support';

const day = 86_400_000;
const dispensedAt = new Date('2026-09-01T09:00:00.000Z');
const scope = { organizationId: 'org_rx', branchId: 'branch_main', actorId: 'pharmacist_1' };

function mockDb(
  options: {
    consent?: boolean;
    revokedAt?: Date;
    recordedAt?: Date;
    rx?: boolean;
    signed?: boolean;
    reviewedInBranch?: boolean;
  } = {}
) {
  const create = vi.fn(async ({ data }) => ({ id: 'reminder_1', status: 'CAPTURED', ...data }));
  return {
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: scope.branchId }) },
    prescriptionFill: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'fill_1',
        prescriptionLineId: 'line_1',
        quantityCanonicalUnits: 30,
        dispensedAt,
        line: {
          directions: 'Take one tablet once daily',
          medicine: {
            rx: options.rx ?? true,
            productName: 'Metformin',
            strengths: [{ value: { toString: () => '500' }, unit: 'mg' }],
          },
          presentation: { dosageForm: 'Tablet', presentation: '30 tablet pack' },
          prescription: { patientId: 'patient_1' },
        },
      }),
    },
    patientConsent: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'consent_2',
        version: 2,
        granted: options.consent ?? true,
        revokedAt: options.revokedAt ?? null,
        recordedAt: options.recordedAt ?? new Date('2026-09-01'),
      }),
    },
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn().mockResolvedValue(
        options.signed === false
          ? null
          : {
              id: 'decision_1',
              signedAt: dispensedAt,
              reviewItem: { saleLineId: 'sale_line_1' },
            }
      ),
    },
    pharmacySaleLine: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.reviewedInBranch === false ? null : { id: 'sale_line_1' }),
    },
    pharmacyRefillReminderCapture: { create },
  };
}

describe('RX-07 refill schedule', () => {
  it('puts a 30-tablet once-daily reminder on day 27', () => {
    const result = deriveRefillSchedule({
      dispensedAt,
      quantityDispensed: 30,
      directions: 'Take one tablet once daily',
    });
    expect((result.reminderAt.getTime() - dispensedAt.getTime()) / day).toBe(27);
    expect((result.expectedExhaustionAt.getTime() - dispensedAt.getTime()) / day).toBe(30);
  });

  it('shortens a partial fill from 30 days to 10 days using actual dispensed quantity', () => {
    const full = deriveRefillSchedule({
      dispensedAt,
      quantityDispensed: 30,
      directions: 'One tablet daily',
    });
    const partial = deriveRefillSchedule({
      dispensedAt,
      quantityDispensed: 10,
      directions: 'One tablet daily',
    });
    expect((partial.reminderAt.getTime() - dispensedAt.getTime()) / day).toBe(7);
    expect(partial.expectedExhaustionAt.getTime()).toBeLessThan(
      full.expectedExhaustionAt.getTime()
    );
  });

  it.each([
    ['Take two tablets twice daily', 4],
    ['One capsule every 8 hours', 3],
    ['1 unit per day', 1],
  ])('derives %s as %s units per day', (directions, expected) => {
    expect(dosesPerDayFromDirections(directions)).toBe(expected);
  });

  it.each(['Take as needed', 'Use when required', 'Take one tablet'])(
    'NEGATIVE: refuses ambiguous directions instead of guessing: %s',
    (directions) => {
      expect(() =>
        deriveRefillSchedule({ dispensedAt, quantityDispensed: 30, directions })
      ).toThrow(
        expect.objectContaining<Partial<RefillSupportError>>({ reason: 'AMBIGUOUS_DIRECTIONS' })
      );
    }
  );
});

describe('RX-07 capture-only reminder gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures schedule and bilingual card fields without invoking a sender', async () => {
    const db = mockDb();
    const result = await captureRefillReminder(db as never, scope, {
      fillId: 'fill_1',
      channel: 'WHATSAPP',
      directionsUrdu: 'روزانہ ایک گولی لیں',
      idempotencyKey: 'refill-fill-1',
    });
    expect(result).toMatchObject({ status: 'CAPTURED', medicineName: 'Metformin' });
    expect(db.pharmacyRefillReminderCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prescriptionFillId: 'fill_1',
        quantityDispensed: 30,
        reminderAt: new Date('2026-09-28T09:00:00.000Z'),
        expectedExhaustionAt: new Date('2026-10-01T09:00:00.000Z'),
        directionsUrdu: 'روزانہ ایک گولی لیں',
      }),
    });
  });

  it('NEGATIVE: refuses an Rx reminder without a signed pharmacist decision', async () => {
    const db = mockDb({ signed: false });
    await expect(
      captureRefillReminder(db as never, scope, {
        fillId: 'fill_1',
        channel: 'WHATSAPP',
        directionsUrdu: 'روزانہ ایک گولی لیں',
        idempotencyKey: 'refill-fill-1',
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<RefillSupportError>>({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      })
    );
    expect(db.pharmacyRefillReminderCapture.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: refuses pharmacist evidence from a sale in another branch', async () => {
    const db = mockDb({ reviewedInBranch: false });
    await expect(
      captureRefillReminder(db as never, scope, {
        fillId: 'fill_1',
        channel: 'WHATSAPP',
        directionsUrdu: 'روزانہ ایک گولی لیں',
        idempotencyKey: 'refill-fill-1',
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<RefillSupportError>>({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      })
    );
    expect(db.pharmacyRefillReminderCapture.create).not.toHaveBeenCalled();
  });

  it.each([{ revokedAt: new Date('2026-09-02') }, { recordedAt: new Date('2999-01-01') }])(
    'NEGATIVE: refuses a granted consent with invalid current evidence %o',
    async (options) => {
      const db = mockDb(options);
      await expect(
        captureRefillReminder(db as never, scope, {
          fillId: 'fill_1',
          channel: 'WHATSAPP',
          directionsUrdu: 'روزانہ',
          idempotencyKey: 'refill-fill-1',
        })
      ).rejects.toMatchObject({ reason: 'REMINDER_CONSENT_REQUIRED' });
      expect(db.pharmacyRefillReminderCapture.create).not.toHaveBeenCalled();
    }
  );

  it('NEGATIVE: refuses capture when reminder consent is absent or revoked', async () => {
    const db = mockDb({ consent: false });
    await expect(
      captureRefillReminder(db as never, scope, {
        fillId: 'fill_1',
        channel: 'SMS',
        directionsUrdu: 'روزانہ ایک گولی لیں',
        idempotencyKey: 'refill-fill-1',
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<RefillSupportError>>({ reason: 'REMINDER_CONSENT_REQUIRED' })
    );
    expect(db.pharmacyRefillReminderCapture.create).not.toHaveBeenCalled();
  });
});
