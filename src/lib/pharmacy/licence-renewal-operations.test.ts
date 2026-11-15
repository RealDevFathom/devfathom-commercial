import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readLicenceRenewalReminders } from './licence-renewal-operations';

const at = new Date('2026-11-15T09:00:00.000Z');
const days = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000);

function profile(licenceValidTo: Date) {
  return {
    branchId: 'branch-1',
    provinceCode: 'PK-PB',
    licenceCategory: 'PHARMACY',
    licenceNumber: 'DSL-123',
    licenceValidTo,
    qualifiedPersonRegistration: 'PCP-77',
    qualifiedPersonValidTo: days(400),
    branch: { name: 'Main branch' },
  };
}

function dbWith(profiles: unknown[], suppliers: unknown[] = []) {
  return {
    branchRegulatoryProfile: { findMany: vi.fn().mockResolvedValue(profiles) },
    pharmacySupplier: { findMany: vi.fn().mockResolvedValue(suppliers) },
  };
}

describe('#720 readLicenceRenewalReminders', () => {
  it('reminds about a seeded licence expiring in 30 days, scoped to the tenant', async () => {
    const db = dbWith([profile(days(30))]);
    const reminders = await readLicenceRenewalReminders(db as never, {
      organizationId: 'org-1',
      at,
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ kind: 'BRANCH_LICENCE', daysLeft: 30, stage: 30 });
    const where = db.branchRegulatoryProfile.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ organizationId: 'org-1', isPlaceholder: false });
    expect(db.pharmacySupplier.findMany.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
    });
  });

  it('stops once the renewed licence is saved as the effective profile', async () => {
    const reminders = await readLicenceRenewalReminders(
      dbWith([profile(days(30 + 730)), profile(days(30))]) as never,
      { organizationId: 'org-1', at }
    );
    expect(reminders).toEqual([]);
  });

  it("uses each supplier's latest verified, unsuperseded licence", async () => {
    const db = dbWith(
      [],
      [
        { name: 'Due supplier', licences: [{ licenceNumber: 'S-1', expiresAt: days(60) }] },
        { name: 'Renewed supplier', licences: [{ licenceNumber: 'S-2', expiresAt: days(500) }] },
        { name: 'No licence', licences: [] },
      ]
    );
    const reminders = await readLicenceRenewalReminders(db as never, {
      organizationId: 'org-1',
      at,
    });
    expect(reminders.map((reminder) => [reminder.holder, reminder.stage])).toEqual([
      ['Due supplier', 60],
    ]);
    const licences = db.pharmacySupplier.findMany.mock.calls[0]![0].select.licences;
    expect(licences.where).toMatchObject({
      verifiedAt: { not: null },
      supersededBy: { none: {} },
    });
    expect(licences).toMatchObject({ orderBy: { expiresAt: 'desc' }, take: 1 });
  });
});

describe('renewal reminders read the profile in force on the workspace day (DEV-298)', () => {
  const dayStart = new Date('2026-10-21T00:00:00.000Z');
  it.each([
    ['00:30 PKT on the start day', new Date('2026-10-20T19:30:00.000Z'), dayStart],
    [
      '23:59 PKT the day before',
      new Date('2026-10-20T18:59:00.000Z'),
      new Date('2026-10-20T18:59:00.000Z'),
    ],
  ])('at %s', async (_label, instant, asOf) => {
    const db = dbWith([]);
    await readLicenceRenewalReminders(db as never, {
      organizationId: 'org-1',
      at: instant,
      timeZone: 'Asia/Karachi',
    });
    expect(db.branchRegulatoryProfile.findMany.mock.calls[0]![0].where).toMatchObject({
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    });
  });
});
