import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./regulatory', async (original) => ({
  ...(await original<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { applyPharmacyTender, openPharmacyDrawer, requirePharmacyDayOpen } from './settlement';
import { closePharmacyDay, readPharmacyClose } from './day-close';
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
const date = new Date('2026-09-29T00:00:00Z');
function fixture() {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ commandType: 'tender', payloadHash: '', resultPayload: null }),
    },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Branch' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner', name: 'Ayesha Karim' }]) },
    pharmacyDrawerSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'drawer',
          deviceId: 'device',
          status: 'OPEN',
          openedAt: new Date('2026-09-29T04:12:00Z'),
          openedByActorId: 'owner',
          countedCashMinor: null,
          movements: [
            { kind: 'OPENING_FLOAT', amountMinor: 10000 },
            { kind: 'CASH_SALE', amountMinor: 2500 },
          ],
        },
      ]),
      create: vi.fn(),
    },
    pharmacySale: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'sale', lines: [{ quantity: 1, unitPriceMinor: 2500, discountMinor: 0 }] },
        ]),
    },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyTender: { findMany: vi.fn().mockResolvedValue([]) },
    // The workspace's zone, which the close screen formats every time in.
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'America/Chicago' }) },
  };
  return { db, scoped: db as unknown as ScopedDb };
}
describe('day close boundaries', () => {
  it('changes the preview hash when a manual partial tender arrives on an open bill', async () => {
    const { db, scoped } = fixture();
    const before = await readPharmacyClose(scoped, scope, date);
    db.pharmacyTender.findMany.mockResolvedValue([{ id: 'manual-1', type: 'RAAST', amountMinor: 100 }]);
    const after = await readPharmacyClose(scoped, scope, date);
    expect(after.totals.sourceHash).not.toBe(before.totals.sourceHash);
    expect(after.tenderTotals).toEqual([{ type: 'RAAST', amountMinor: 100, refundMinor: 0, netMinor: 100 }]);
    await expect(closePharmacyDay(scoped, scope, { businessDate: date, sourceHash: before.totals.sourceHash,
      counts: [{ drawerSessionId: 'drawer', countedCashMinor: 12500 }], varianceNote: '' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('computes expected cash including float and sales within the tenant/branch/date', async () => {
    const { db, scoped } = fixture();
    const p = await readPharmacyClose(scoped, scope, date);
    expect(p.totals).toMatchObject({ cashExpectedMinor: 12500, grossSalesMinor: 2500 });
    // Each drawer names its opener and time, read within the tenant, so the close
    // screen never has to show the counter's device identifier.
    expect(p.drawers[0]).toMatchObject({
      id: 'drawer',
      openedAt: new Date('2026-09-29T04:12:00Z'),
      openedBy: 'Ayesha Karim',
    });
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', id: { in: ['owner'] } },
      select: { id: true, name: true },
    });
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org',
          branchId: 'branch',
          businessDate: date,
          status: 'COMPLETED',
        },
      })
    );
  });
  it('carries the workspace zone, read for the scope’s organization, with the close', async () => {
    const { db, scoped } = fixture();
    await expect(readPharmacyClose(scoped, scope, date)).resolves.toMatchObject({
      timezone: 'America/Chicago',
    });
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org' },
      select: { timezone: true },
    });
  });
  it.each([[{ timezone: 'PKT' }], [{ timezone: 'UTC+5' }], [null]])(
    'hands over UTC for a stored zone Intl refuses or a missing one (%j)',
    async (organization) => {
      const { db, scoped } = fixture();
      db.organization.findUnique.mockResolvedValue(organization);
      await expect(readPharmacyClose(scoped, scope, date)).resolves.toMatchObject({
        timezone: 'UTC',
      });
    }
  );
  it('refuses an unknown or foreign branch', async () => {
    const { db, scoped } = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(readPharmacyClose(scoped, scope, date)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('rejects a stale preview before writing counts', async () => {
    const { scoped } = fixture();
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: 'stale',
        counts: [],
        varianceNote: '',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('requires every open drawer exactly once', async () => {
    const { scoped } = fixture();
    const p = await readPharmacyClose(scoped, scope, date);
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: p.totals.sourceHash,
        counts: [],
        varianceNote: '',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('requires a note for a variance', async () => {
    const { scoped } = fixture();
    const p = await readPharmacyClose(scoped, scope, date);
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: p.totals.sourceHash,
        counts: [{ drawerSessionId: 'drawer', countedCashMinor: 12400 }],
        varianceNote: ' ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('returns an existing close on retry', async () => {
    const { db, scoped } = fixture();
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close' });
    await expect(
      closePharmacyDay(scoped, scope, {
        businessDate: date,
        sourceHash: 'old',
        counts: [],
        varianceNote: '',
      })
    ).resolves.toEqual({ id: 'close' });
  });
  it('refuses reopening a drawer after day close', async () => {
    const { db, scoped } = fixture();
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close' });
    await expect(
      openPharmacyDrawer(scoped, scope, {
        businessDate: date,
        deviceId: 'device',
        openingFloatMinor: 0,
      })
    ).rejects.toMatchObject({ reason: 'DAY_CLOSED' });
    expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });
  it.each(['CASH', 'BANK_TRANSFER', 'CREDIT'] as const)(
    'blocks a new %s tender after close',
    async (type) => {
      const { db, scoped } = fixture();
      const input = {
        saleId: 'sale',
        businessDate: date,
        deviceId: 'device',
        type,
        amountMinor: 100,
        idempotencyKey: 'new',
      };
      db.pharmacyMoneyIdempotencyKey.findUnique.mockResolvedValue({
        commandType: 'tender',
        payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        resultPayload: null,
      });
      db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'closed' });
      await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({
        reason: 'DAY_CLOSED',
      });
    }
  );
  it('acquires the transaction lock before testing the day lock', async () => {
    const { db, scoped } = fixture();
    await requirePharmacyDayOpen(scoped, scope, date);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyDailyClose.findFirst.mock.invocationCallOrder[0]
    );
  });
});

describe('day close open bills (DEV-623)', () => {
  it('counts every unpaid OPEN and HELD bill in the branch, whatever its date', async () => {
    const { db, scoped } = fixture();
    db.pharmacySale.findMany.mockImplementation(async (args: { where: { status: unknown } }) =>
      args.where.status === 'COMPLETED'
        ? [{ id: 'sale', lines: [{ quantity: 1, unitPriceMinor: 2500, discountMinor: 0 }] }]
        : [{ status: 'OPEN' }, { status: 'OPEN' }, { status: 'HELD' }]
    );

    const preview = await readPharmacyClose(scoped, scope, date);

    expect(preview.openBills).toEqual({ open: 2, held: 1 });
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', branchId: 'branch', status: { in: ['OPEN', 'HELD'] } },
      select: { status: true },
    });
    // Unpaid bills are reported, never counted as sales.
    expect(preview.totals).toMatchObject({ grossSalesMinor: 2500 });
  });
});
