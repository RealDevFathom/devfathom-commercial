import { describe, expect, it, vi } from 'vitest';

import { readCounterPatientPanel } from './counter-prescriptions';

function counterDb() {
  const organization = { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) };
  return {
    organization,
    db: {
      organization,
      pharmacyPatient: {
        findFirst: vi.fn(async () => ({
          id: 'patient-1',
          displayName: 'Patient One',
          cnic: null,
          phone: null,
          address: null,
          dateOfBirth: null,
          consents: [],
          prescriptions: [
            {
              id: 'prescription-1',
              sourceKind: 'PAPER',
              custodyState: 'HELD',
              validFrom: new Date('2026-10-01T00:00:00.000Z'),
              validUntil: new Date('2026-10-22T00:00:00.000Z'),
              authorizedRepeats: 0,
              prescriber: { name: 'Doctor One' },
              lines: [],
            },
          ],
        })),
      },
    },
  };
}

describe('counter prescription organization calendar gate', () => {
  it.each([
    ['2026-09-30T18:59:59.999Z', false],
    ['2026-09-30T19:00:00.000Z', true],
    ['2026-10-22T18:59:59.999Z', true],
    ['2026-10-22T19:00:00.000Z', false],
  ])('reports Pakistan calendar validity at %s as %s', async (at, expected) => {
    const { db, organization } = counterDb();

    const panel = await readCounterPatientPanel(db as never, 'org-1', 'patient-1', new Date(at));

    expect(panel.prescriptions[0]?.inDate).toBe(expected);
    expect(organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
  });
});
