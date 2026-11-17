/**
 * DEV-830 (security scan F05): a signed offline replay named its own canonical-unit
 * multiplier, so a PACK line with `canonicalUnitsPerSaleUnit: 1` consumed one unit of
 * device quota and stock while recording a pack sale at a single unit's price. The
 * multiplier is checked against the stored pack setup before any quota or stock moves.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const mocks = vi.hoisted(() => ({
  recordOfflineCommand: vi.fn(),
  createSale: vi.fn(),
  addSaleLine: vi.fn(),
  openDeviceLotQuota: vi.fn(),
  consumeDeviceLotQuota: vi.fn(),
}));

vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  authenticatePharmacyCommand: vi.fn(async () => undefined),
  validateLeasedReceiptReplay: vi.fn(() => undefined),
  createSale: mocks.createSale,
  addSaleLine: mocks.addSaleLine,
}));

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
function command(multiplier: number) {
  const receiptEnvelope = envelope('RULES', { kind: 'RULES' });
  return router.counterReplaySchema.parse({
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
      const payload = { kind };
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
  });
}

/** `$queryRaw` takes a tagged-template strings array or a `Prisma.Sql` object plus bound values. */
type QueryRawMock = (
  query: TemplateStringsArray | Prisma.Sql,
  ...values: unknown[]
) => Promise<unknown[]>;

function dbWithQueryRaw() {
  const queryRaw = vi.fn<QueryRawMock>(async () => []);
  const packLevel = {
    // One sealed pack counted directly in ten canonical tablets.
    findMany: vi.fn(async () => [
      { id: 'pack_1', level: 'PACK', parentPackLevelId: null, unitsPerParent: 10 },
    ]),
    findFirst: vi.fn(async () => ({ id: 'pack_1' })),
  };
  const target = {
    $queryRaw: queryRaw,
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
  };
  return { target: target as unknown as ScopedDb, queryRaw };
}

function db() {
  return dbWithQueryRaw().target;
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
    const body = command(10);
    body.lines.push({ ...body.lines[0]! });
    await expect(replay(target, body)).rejects.toThrow('REACHED_LINE');
    const calls = vi.mocked(target.$queryRaw).mock.calls as unknown as unknown[][];
    const keys = calls.flatMap((call, index) =>
      typeof call[1] === 'string' && call[1].startsWith('org_a:sale-line:')
        ? [{ key: call[1], index }]
        : []
    );
    expect(keys.map(({ key }) => key)).toEqual([
      'org_a:sale-line:idem_1:0',
      'org_a:sale-line:idem_1:1',
    ]);
    const stock = calls.findIndex(([query]) =>
      Boolean((query as { sql?: string }).sql?.includes('AS "batchId"'))
    );
    expect(stock).toBeGreaterThanOrEqual(0);
    for (const key of keys) expect(key.index).toBeLessThan(stock);
  });
});
s) expect(key.index).toBeLessThan(stock);
  });
});
