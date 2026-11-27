/**
 * DEV-944: an offline sale replays onto the shop's day of its own signed sale time, on
 * the organisation's stored clock. It used to land on the UTC date of the sale, so a sale
 * made offline at 00:30 in Karachi (19:30 UTC the day before) was booked on the previous
 * day and drawer. An organisation on UTC keeps the old booking, and a sale already
 * replayed is never moved.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';
import { offlineSaleChain } from '@/lib/test-support/offline-sale-seal';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const mocks = vi.hoisted(() => ({
  recordOfflineCommand: vi.fn(),
  settleOfflineCommand: vi.fn(),
  createSale: vi.fn(),
  addSaleLine: vi.fn(),
  applyPharmacyTender: vi.fn(),
  openDeviceLotQuota: vi.fn(),
  consumeDeviceLotQuota: vi.fn(),
}));

// Exercise booking with the live switch on. The live-off case has a separate DB test.
vi.mock('@/lib/pharmacy/offline-cash-selling', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/offline-cash-selling')>()),
  readOfflineCashSelling: async () => ({ enabled: true, available: true }),
}));

vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  authenticatePharmacyCommand: vi.fn(async () => undefined),
  validateLeasedReceiptReplay: vi.fn(() => undefined),
  assertSaleUnitConversion: vi.fn(async () => undefined),
  createSale: mocks.createSale,
  addSaleLine: mocks.addSaleLine,
}));

vi.mock('@/lib/pharmacy/settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/settlement')>()),
  applyPharmacyTender: mocks.applyPharmacyTender,
}));

vi.mock('@/lib/pharmacy/offline-command-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-command-log')>()),
  recordOfflineCommand: mocks.recordOfflineCommand,
  settleOfflineCommand: mocks.settleOfflineCommand,
}));

vi.mock('@/lib/pharmacy/offline-quotas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-quotas')>()),
  openDeviceLotQuota: mocks.openDeviceLotQuota,
  consumeDeviceLotQuota: mocks.consumeDeviceLotQuota,
}));

type Router = typeof import('./pharmacy-offline');
type Signing = typeof import('@/lib/pharmacy/offline-snapshots');
let router: Router;
let signing: Signing;

beforeAll(async () => {
  router = await import('./pharmacy-offline');
  signing = await import('@/lib/pharmacy/offline-snapshots');
});

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'actor_a' };
const DEVICE = 'counter_1';
// The signed leases cover the evening of 1 Nov and the morning of 2 Nov (UTC).
const ISSUED_AT = '2026-11-01T12:00:00.000Z';
const EXPIRES_AT = '2026-11-02T12:00:00.000Z';
const KINDS = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'] as const;

function envelope(
  kind: OfflineSnapshotEnvelope['kind'],
  payload: unknown
): OfflineSnapshotEnvelope {
  return {
    organizationId: SCOPE.organizationId,
    branchId: SCOPE.branchId,
    deviceId: DEVICE,
    kind,
    version: 1,
    payloadHash: signing.snapshotPayloadHash(payload),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    safetyLease: {
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      recallVersion: 0,
      licenceVersion: 0,
      ruleVersion: 0,
      recalledBatchIds: [],
    },
    signingKeyId: signing.SNAPSHOT_SIGNING_KEY_ID,
  };
}


/**
 * DEV-957 phase 2 (hardening 4): the counter seals each sale when it is taken; the route
 * checks that seal. This counter's first sale names no sale before it.
 */
function command(originalSaleAt: string) {
  return router.counterReplaySchema.parse(offlineSaleChain(SCOPE, DEVICE, 'pcd_secret').seal(unsealedCommand(originalSaleAt), {
    previousHash: null,
  }));
}

function unsealedCommand(originalSaleAt: string) {
  const receiptEnvelope = envelope('RULES', { kind: 'RULES' });
  return {
    sequence: 1,
    idempotencyKey: 'idem_1',
    action: 'CASH_OTC_SALE',
    leasedReceipt: {
      leaseId: 'lease_1',
      receiptNumber: 900,
      originalSaleAt,
      envelope: receiptEnvelope,
      signature: signing.signSnapshotEnvelope(receiptEnvelope),
    },
    snapshots: KINDS.map((kind) => {
      // Offline cash selling forced ON in the signed RULES (it is off in the product).
      const payload = kind === 'RULES' ? { kind, offlineCashSelling: true } : { kind };
      const signed = envelope(kind, payload);
      return { envelope: signed, signature: signing.signSnapshotEnvelope(signed), payload };
    }),
    lines: [
      {
        medicineId: 'med_1',
        presentationId: 'presentation_1',
        packLevelId: 'pack_1',
        saleUnit: 'PACK',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        inventoryLotId: 'lot_1',
        stockLocationId: 'loc_1',
      },
    ],
    amountMinor: 100,
    cashReceivedMinor: 100,
  };
}

function db(timezone: string | null, businessDayEndsAtHistory = 0) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: {
      findUnique: vi.fn(async () => (timezone === null ? null : { timezone })),
    },
    // DEV-958A: the branch's "day ends at" hour; 0 (midnight) unless a test sets it.
    pharmacyBranch: { findFirst: vi.fn(async () => ({ businessDayEndsAtHistory })) },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [{ id: 'lot_1', batch: { state: 'ACTIVE' } }]),
    },
    pharmacyOfflineCommand: { findFirst: vi.fn(async () => null) },
    pharmacySale: {
      findFirst: vi.fn(async () => ({ receiptNumber: 900, offlineReceiptReference: null })),
    },
    pharmacySaleLineAllocation: {
      findMany: vi.fn(async () => [{ inventoryLotId: 'lot_1', stockLocationId: 'loc_1' }]),
    },
    medicine: {
      findFirst: vi.fn(async () => ({ controlled: false, rx: false, restricted: false })),
    },
    presentation: { findFirst: vi.fn(async () => ({ id: 'presentation_1' })) },
    packLevel: { findFirst: vi.fn(async () => ({ id: 'pack_1' })) },
  } as unknown as ScopedDb;
}

function replay(target: ScopedDb, body: ReturnType<typeof command>) {
  return router.replayCounterCommand(
    { db: target, scope: SCOPE, deviceId: DEVICE, deviceSecret: 'pcd_secret' },
    body,
    'command-signature',
    'receipt-signature'
  );
}

/** The calendar day the replay booked: the tender's date and the day lock it took. */
function bookedDay(target: ScopedDb) {
  const tender = mocks.applyPharmacyTender.mock.calls[0]![2] as { businessDate: Date };
  const lockKeys = vi
    .mocked(target.$queryRaw)
    .mock.calls.map(([query]) => (query as { values?: unknown[] }).values ?? [])
    .flat()
    .filter(
      (value): value is string =>
        typeof value === 'string' && /^org_a:branch_a:\d{4}-\d{2}-\d{2}$/.test(value)
    );
  return { tender: tender.businessDate.toISOString(), lockKeys };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.recordOfflineCommand.mockResolvedValue({
    command: { id: 'cmd_1', status: 'PENDING', serverRef: null, receiptNumber: 900 },
  });
  mocks.createSale.mockResolvedValue({ id: 'sale_1' });
  mocks.addSaleLine.mockResolvedValue({ line: { id: 'line_1' } });
  mocks.openDeviceLotQuota.mockResolvedValue({ quotaUnits: 100, consumedUnits: 0 });
  mocks.consumeDeviceLotQuota.mockResolvedValue(undefined);
  mocks.applyPharmacyTender.mockResolvedValue({ settled: true, receiptNumber: 900 });
  mocks.settleOfflineCommand.mockResolvedValue(undefined);
});

describe('DEV-944 offline replay books on the shop day of the sale', () => {
  it.each([
    // 00:30 on 2 Nov in Karachi: the UTC date is still 1 Nov.
    ['2026-11-01T19:30:00.000Z', '2026-11-02'],
    // 23:59 on 1 Nov in Karachi: the last minute of the shop's 1 Nov.
    ['2026-11-01T18:59:00.000Z', '2026-11-01'],
    // 10:00 on 2 Nov in Karachi: the same day either way.
    ['2026-11-02T05:00:00.000Z', '2026-11-02'],
  ])('books a Karachi sale signed at %s on %s', async (soldAt, day) => {
    const target = db('Asia/Karachi');
    await expect(replay(target, command(soldAt))).resolves.toMatchObject({
      saleId: 'sale_1',
      replayed: false,
    });
    expect(target.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org_a' },
      select: { timezone: true },
    });
    const booked = bookedDay(target);
    expect(booked.tender).toBe(`${day}T00:00:00.000Z`);
    expect(new Set(booked.lockKeys)).toEqual(new Set([`org_a:branch_a:${day}`]));
  });

  it.each([
    // Characterised behaviour before DEV-944, kept for an organisation on UTC, one with no
    // organisation row and one whose stored zone Intl refuses: the UTC date of the sale.
    ['UTC', '2026-11-01T19:30:00.000Z', '2026-11-01'],
    ['UTC', '2026-11-01T18:59:00.000Z', '2026-11-01'],
    ['UTC', '2026-11-02T05:00:00.000Z', '2026-11-02'],
    [null, '2026-11-01T19:30:00.000Z', '2026-11-01'],
    ['PKT', '2026-11-01T19:30:00.000Z', '2026-11-01'],
  ])('keeps the UTC date for zone %s at %s', async (zone, soldAt, day) => {
    const target = db(zone);
    await replay(target, command(soldAt));
    const booked = bookedDay(target);
    expect(booked.tender).toBe(`${day}T00:00:00.000Z`);
    expect(new Set(booked.lockKeys)).toEqual(new Set([`org_a:branch_a:${day}`]));
  });

  it('never moves a sale already replayed: a retry returns it without booking again', async () => {
    mocks.recordOfflineCommand.mockResolvedValue({
      command: { id: 'cmd_1', status: 'ACCEPTED', serverRef: 'sale_1', receiptNumber: 900 },
    });
    const target = db('Asia/Karachi');
    await expect(replay(target, command('2026-11-01T19:30:00.000Z'))).resolves.toEqual({
      saleId: 'sale_1',
      receiptNumber: 900,
      replayed: true,
    });
    expect(target.organization.findUnique).not.toHaveBeenCalled();
    expect(mocks.createSale).not.toHaveBeenCalled();
    expect(mocks.applyPharmacyTender).not.toHaveBeenCalled();
    expect(mocks.settleOfflineCommand).not.toHaveBeenCalled();
    expect(bookedDayLocks(target)).toEqual([]);
  });

  it('books the same day each time the same signed sale is replayed', async () => {
    const first = db('Asia/Karachi');
    await replay(first, command('2026-11-01T19:30:00.000Z'));
    const firstDay = bookedDay(first).tender;
    mocks.applyPharmacyTender.mockClear();
    const second = db('Asia/Karachi');
    await replay(second, command('2026-11-01T19:30:00.000Z'));
    expect(bookedDay(second).tender).toBe(firstDay);
  });

  it('takes the zone from the organisation row, not the device', async () => {
    const body = command('2026-11-01T19:30:00.000Z');
    expect(
      router.counterReplaySchema.safeParse({ ...body, timeZone: 'Asia/Karachi' }).success
    ).toBe(false);
  });
});

describe('DEV-958A offline replay books on the branch business day', () => {
  it.each([
    // 23:30, 00:30 and 05:30 in Karachi on the night of 1 to 2 Nov.
    ['2026-11-01T18:30:00.000Z', 0, '2026-11-01'],
    ['2026-11-01T19:30:00.000Z', 0, '2026-11-02'],
    ['2026-11-02T00:30:00.000Z', 0, '2026-11-02'],
    ['2026-11-01T18:30:00.000Z', 5, '2026-11-01'],
    // The late shift: 00:30 at a branch whose day ends at 05:00 is still 1 Nov, its drawer.
    ['2026-11-01T19:30:00.000Z', 5, '2026-11-01'],
    ['2026-11-02T00:30:00.000Z', 5, '2026-11-02'],
  ])(
    'books a sale signed at %s at a branch ending its day at %s:00 on %s',
    async (soldAt, hour, day) => {
      const target = db('Asia/Karachi', hour);
      await replay(target, command(soldAt));
      expect(target.pharmacyBranch.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_a', id: 'branch_a' },
        select: { businessDayEndsAtHistory: true },
      });
      const booked = bookedDay(target);
      expect(booked.tender).toBe(`${day}T00:00:00.000Z`);
      expect(new Set(booked.lockKeys)).toEqual(new Set([`org_a:branch_a:${day}`]));
    }
  );
});

function bookedDayLocks(target: ScopedDb) {
  return vi
    .mocked(target.$queryRaw)
    .mock.calls.map(([query]) => (query as { values?: unknown[] }).values ?? [])
    .flat()
    .filter((value) => typeof value === 'string' && /^org_a:branch_a:\d{4}-/.test(value));
}
