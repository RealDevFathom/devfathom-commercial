import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { readCounterPatientPanel } from './counter-prescriptions';
import { prescriptionCalendarDate } from './prescription-calendar';

describe('counter prescription calendar validity', () => {
  it.each([
    ['Asia/Karachi', '2026-10-21T18:59:59.999Z', false],
    ['Asia/Karachi', '2026-10-21T19:00:00.000Z', true],
    ['Asia/Karachi', '2026-10-22T12:00:00.000Z', true],
    ['Asia/Karachi', '2026-10-22T18:59:59.999Z', true],
    ['Asia/Karachi', '2026-10-22T19:00:00.000Z', false],
    ['America/Los_Angeles', '2026-10-23T06:59:59.999Z', true],
    ['America/Los_Angeles', '2026-10-23T07:00:00.000Z', false],
    ['PKT', '2026-10-22T23:59:59.999Z', true],
    [null, '2026-10-23T00:00:00.000Z', false],
  ])('uses the organization day in %s at %s', async (timezone, at, inDate) => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'patient-a',
      displayName: 'Synthetic patient',
      cnic: null,
      phone: null,
      dateOfBirth: null,
      address: null,
      consents: [],
      prescriptions: [
        {
          id: 'rx-a',
          sourceKind: 'PAPER_IMAGE',
          custodyState: 'NOT_HELD',
          validFrom: prescriptionCalendarDate('2026-10-22'),
          validUntil: prescriptionCalendarDate('2026-10-22'),
          authorizedRepeats: 0,
          prescriber: { name: 'Synthetic prescriber' },
          lines: [],
        },
      ],
    });
    const findUnique = vi.fn().mockResolvedValue({ timezone });
    const db = {
      pharmacyPatient: { findFirst },
      organization: { findUnique },
    } as unknown as ScopedDb;

    const panel = await readCounterPatientPanel(db, 'org-a', 'patient-a', new Date(at));

    expect(panel.prescriptions[0]).toMatchObject({
      validFrom: '2026-10-22T00:00:00.000Z',
      validUntil: '2026-10-22T00:00:00.000Z',
      inDate,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'patient-a', organizationId: 'org-a' },
      })
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'org-a' },
      select: { timezone: true },
    });
  });
});
