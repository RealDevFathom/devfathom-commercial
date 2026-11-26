/**
 * DEV-830 (security scan F05): a signed offline replay named its own canonical-unit
 * multiplier, so a PACK line with `canonicalUnitsPerSaleUnit: 1` consumed one unit of
 * device quota and stock while recording a pack sale at a single unit's price. The
 * multiplier is checked against the stored pack setup before any quota or stock moves.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';
import { offlineSaleChain } from '@/lib/test-support/offline-sale-seal';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const mocks = vi.hoisted(() => ({
  recordOfflineCommand: vi.fn(),
  createSale: vi.fn(),
  addSaleLine: vi.fn(),
  openDeviceLotQuota: vi.fn(),
  consumeDeviceLotQuota: vi.fn(),
}));

// Exercise booking with the live switch on. The live-off case has a separate DB test.
vi.mock('@/lib/pharmacy/offline-cash-selling', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/offline-cash-selling')>()),
  readOfflineCashSelling: async () => ({ enabled: true, available: true }),
}));

vi.mock('@/lib/pharmacy/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/sales')>();
  return {
    ...actual,
    // Exercise the real lease checks at the fixture's replay time.
    validateLeasedReceiptReplay: (...args: Parameters<typeof actual.validateLeasedReceiptReplay>) =>
      actual.validateLeasedReceiptReplay(args[0], args[1], args[2], Date.parse(SALE_AT)),
    authenticatePharmacyCommand: vi.fn(async () => undefined),
    createSale: mocks.createSale,
    addSaleLine: mocks.addSaleLine,
  };
});

vi.mock('@/lib/pharmacy/offline-command-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-command-log')>()),
  recordOfflineCommand: mocks.recordOfflineCommand,
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
const ISSUED_AT = '2026-09-02T09:00:00.000Z';
const EXPIRES_AT = '2026-09-02T17:00:00.000Z';
const SALE_AT = '2026-09-02T12:00:00.000Z';
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

/** A ten-tablet pack sold as one PACK; `multiplier` is what the device claims it holds. */

/**
 * DEV-957 phase 2 (hardening 4): the counter seals each sale when it is taken; the route
 * checks that seal. This counter's first sale names no sale before it.
 */
function command(multiplier: number) {
  return router.counterReplaySchema.parse(
    offlineSaleChain(SCOPE, DEVICE, 'pcd_secret').seal(unsealedCommand(multiplier), {
      previousHash: null,
    })
  );
}

function unsealedCommand(multiplier: number, cashierId?: string) {
  const receiptEnvelope = envelope('RULES', { kind: 'RULES' });
  return {
    sequence: 1,
    idempotencyKey: 'idem_1',
    action: 'CASH_OTC_SALE',
    leasedReceipt: {
      leaseId: 'lease_1',
      receiptNumber: 900,
      originalSaleAt: SALE_AT,
      envelope: receiptEnvelope,
      signature: signing.signSnapshotEnvelope(receiptEnvelope),
    },
    snapshots: KINDS.map((kind) => {
      // Offline cash selling forced ON in the signed RULES (it is off in the product).
      const payload =
        kind === 'RULES'
          ? {
              kind,
              offlineCashSelling: true,
              ...(cashierId ? { operator: { userId: cashierId } } : {}),
            }
          : { kind };
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
        canonicalUnitsPerSaleUnit: multiplier,
        inventoryLotId: 'lot_1',
        stockLocationId: 'loc_1',
      },
    ],
    amountMinor: 100,
    cashReceivedMinor: 100,
  };
}

function db(priorRefusal?: string) {
  const packLevel = {
    // One sealed pack counted directly in ten canonical tablets.
    findMany: vi.fn(async () => [
      { id: 'pack_1', level: 'PACK', parentPackLevelId: null, unitsPerParent: 10 },
    ]),
    findFirst: vi.fn(async () => ({ id: 'pack_1' })),
  };
  return {
    $queryRaw: vi.fn(async (query: unknown) =>
      priorRefusal &&
      Array.isArray(query) &&
      query.join('').includes('SELECT reason FROM pharmacy_offline_receipt_events')
        ? [{ reason: priorRefusal }]
        : []
    ),
    // The sale's business day is read on the organisation's stored clock.
    organization: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
    // DEV-958A: the branch's "day ends at" hour; none stored reads as midnight.
    pharmacyBranch: { findFirst: async () => null },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [{ id: 'lot_1', batch: { state: 'ACTIVE' } }]),
      // No lot of this medicine was received as a one-tablet pack.
      findFirst: vi.fn(async () => null),
    },
    pharmacyOfflineCommand: { findFirst: vi.fn(async () => null) },
    medicine: {
      findFirst: vi.fn(async () => ({ controlled: false, rx: false, restricted: false })),
    },
    presentation: { findFirst: vi.fn(async () => ({ id: 'presentation_1' })) },
    packLevel,
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

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.recordOfflineCommand.mockResolvedValue({
    command: { id: 'cmd_1', status: 'PENDING', serverRef: null, receiptNumber: 900 },
  });
  mocks.createSale.mockResolvedValue({ id: 'sale_1' });
  mocks.openDeviceLotQuota.mockResolvedValue({ quotaUnits: 100, consumedUnits: 0 });
  mocks.consumeDeviceLotQuota.mockResolvedValue(undefined);
  mocks.addSaleLine.mockRejectedValue(new Error('REACHED_LINE'));
});

describe('DEV-830 offline replay derives the sale-unit multiplier', () => {
  it('identifies a failed receipt envelope signature for supervisor quarantine', async () => {
    const body = command(10);
    body.leasedReceipt.signature = Buffer.alloc(64).toString('base64');
    await expect(replay(db(), body)).rejects.toMatchObject({
      code: 'invalid_snapshot',
      status: 403,
    });
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('books the signed cashier on the sale and line when a different operator reconnects', async () => {
    const target = db();
    const cashier = 'cashier_at_sale';
    const body = router.counterReplaySchema.parse(
      offlineSaleChain(SCOPE, DEVICE, 'pcd_secret').seal(unsealedCommand(10, cashier), {
        previousHash: null,
      })
    );
    await expect(replay(target, body)).rejects.toThrow('REACHED_LINE');
    expect(mocks.createSale).toHaveBeenCalledWith(target, { ...SCOPE, actorId: cashier });
    expect(mocks.addSaleLine.mock.calls[0]?.[1]).toEqual({ ...SCOPE, actorId: cashier });
  });

  it.each(['controlled', 'rx', 'restricted', 'highAlert', 'lasa'])(
    'refuses a %s medicine during replay before consuming stock',
    async (flag) => {
      const target = db();
      vi.mocked(target.medicine.findFirst).mockResolvedValueOnce({ [flag]: true } as never);
      await expect(replay(target, command(10))).rejects.toMatchObject({
        code: 'medicine_not_offline_otc',
      });
      expect(mocks.consumeDeviceLotQuota).not.toHaveBeenCalled();
      expect(mocks.addSaleLine).not.toHaveBeenCalled();
    }
  );

  it('requires supervisor review of the same receipt after a drawer refusal', async () => {
    const target = db('DRAWER_NOT_OPEN');
    await expect(replay(target, command(10))).rejects.toMatchObject({
      code: 'DRAWER_NOT_OPEN',
      status: 409,
    });
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('refuses a PACK with a single-unit multiplier before quota or stock moves', async () => {
    await expect(replay(db(), command(1))).rejects.toMatchObject({
      code: 'invalid_pack',
      status: 403,
    });
    expect(mocks.openDeviceLotQuota).not.toHaveBeenCalled();
    expect(mocks.consumeDeviceLotQuota).not.toHaveBeenCalled();
    expect(mocks.addSaleLine).not.toHaveBeenCalled();
  });

  it('lets a PACK at its stored multiplier consume quota and reach the sale line', async () => {
    await expect(replay(db(), command(10))).rejects.toThrow('REACHED_LINE');
    expect(mocks.consumeDeviceLotQuota).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ units: 10 })
    );
    expect(mocks.addSaleLine).toHaveBeenCalledOnce();
    // The line is checked against the pack setup in effect at the signed sale time.
    expect(mocks.addSaleLine.mock.calls[0]![3]).toEqual({ saleUnitAt: new Date(SALE_AT) });
  });
});

describe('DEV-874 offline add-line lock ordering', () => {
  it('locks every line key before preparing stock, including later lines in the command', async () => {
    const target = db();
    const unsealed = unsealedCommand(10);
    unsealed.lines.push({ ...unsealed.lines[0]! });
    // The counter seals the sale it took, with both lines.
    const body = router.counterReplaySchema.parse(
      offlineSaleChain(SCOPE, DEVICE, 'pcd_secret').seal(unsealed, { previousHash: null })
    );
    await expect(replay(target, body)).rejects.toThrow('REACHED_LINE');
    // Typed by ScopedDb: tagged-template locks pass (strings, ...values), stock reads one Prisma.Sql.
    const calls = vi.mocked(target.$queryRaw).mock.calls;
    const keys = calls.flatMap(([, value], index) =>
      typeof value === 'string' && value.startsWith('org_a:sale-line:')
        ? [{ key: value, index }]
        : []
    );
    expect(keys.map(({ key }) => key)).toEqual([
      'org_a:sale-line:idem_1:0',
      'org_a:sale-line:idem_1:1',
    ]);
    const stock = calls.findIndex(
      ([query]) => query instanceof Prisma.Sql && query.sql.includes('AS "batchId"')
    );
    expect(stock).toBeGreaterThanOrEqual(0);
    for (const key of keys) expect(key.index).toBeLessThan(stock);
  });
});

describe('DEV-631 offline replay lock order', () => {
  it('takes the sale day lock before any stock lock, as the online counter does', async () => {
    const target = db();
    await expect(replay(target, command(10))).rejects.toThrow('REACHED_LINE');
    const queries = (target.$queryRaw as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([query]) => {
        const sql = query as { sql?: string; strings?: string[]; values?: unknown[] };
        return { text: sql.sql ?? sql.strings?.join('?') ?? '', values: sql.values ?? [] };
      }
    );
    const dayLock = queries.findIndex(
      (query) =>
        query.text.includes('pg_advisory_xact_lock') &&
        query.values.includes(`${SCOPE.organizationId}:${SCOPE.branchId}:${SALE_AT.slice(0, 10)}`)
    );
    const firstStockLock = queries.findIndex((query) =>
      /pharmacy_inventory_lots|pharmacy_stock_balances|manufacturing_batches/.test(query.text)
    );
    expect(dayLock).toBeGreaterThanOrEqual(0);
    expect(firstStockLock).toBeGreaterThan(dayLock);
  });
});
