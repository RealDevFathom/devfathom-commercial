import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
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
    pharmacyDrawerSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'drawer',
          deviceId: 'device',
          status: 'OPEN',
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
  };
  return { db, scoped: db as unknown as ScopedDb };
}
describe('day close boundaries', () => {
  it('computes expected cash including float and sales within the tenant/branch/date', async () => {
    const { db, scoped } = fixture();
    const p = await readPharmacyClose(scoped, scope, date);
    expect(p.totals).toMatchObject({ cashExpectedMinor: 12500, grossSalesMinor: 2500 });
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
