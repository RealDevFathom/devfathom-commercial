/**
 * #519 — offline replay must not be fail-open for recalls. The signed safety
 * lease carries the server's recall set, and replay derives `batchRecalled`
 * from that lease and from the server's current batch state instead of
 * hard-coding `false`.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const mocks = vi.hoisted(() => ({
  recordOfflineCommand: vi.fn(),
  createSale: vi.fn(),
}));

vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  authenticatePharmacyCommand: vi.fn(async () => undefined),
  validateLeasedReceiptReplay: vi.fn(() => undefined),
  createSale: mocks.createSale,
}));

vi.mock('@/lib/pharmacy/offline-command-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-command-log')>()),
  recordOfflineCommand: mocks.recordOfflineCommand,
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
  payload: unknown,
  recalledBatchIds: string[]
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
      recalledBatchIds,
    },
    signingKeyId: signing.SNAPSHOT_SIGNING_KEY_ID,
  };
}

function command(recalledBatchIds: string[] = []) {
  const receiptEnvelope = envelope('RULES', { kind: 'RULES' }, recalledBatchIds);
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
      const signed = envelope(kind, payload, recalledBatchIds);
      return { envelope: signed, signature: signing.signSnapshotEnvelope(signed), payload };
    }),
    lines: [
      {
        medicineId: 'med_1',
        presentationId: 'presentation_1',
        packLevelId: 'pack_1',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        inventoryLotId: 'lot_1',
        stockLocationId: 'loc_1',
      },
    ],
    amountMinor: 100,
    cashReceivedMinor: 100,
  });
}

function db(lots: Array<{ id: string; batch: { state: string } }>) {
  const findMany = vi.fn(async () => lots);
  return {
    findMany,
    db: {
      $queryRaw: vi.fn(async () => []),
      pharmacyInventoryLot: { findMany },
      pharmacyOfflineCommand: { findFirst: vi.fn(async () => null) },
      // DEV-637: a retry answers with the number the sale was issued.
      pharmacySale: {
        findFirst: vi.fn(async () => ({ receiptNumber: 900, offlineReceiptReference: null })),
      },
    } as unknown as ScopedDb,
  };
}

function replay(target: ScopedDb, body = command()) {
  return router.replayCounterCommand(
    { db: target, scope: SCOPE, deviceId: DEVICE, deviceSecret: 'pcd_secret' },
    body,
    'command-signature',
    'receipt-signature'
  );
}

beforeEach(() => {
  mocks.recordOfflineCommand.mockReset();
  mocks.recordOfflineCommand.mockResolvedValue({
    command: { id: 'cmd_1', status: 'PENDING', serverRef: null, receiptNumber: 900 },
  });
  mocks.createSale.mockReset();
  mocks.createSale.mockRejectedValue(new Error('REACHED_SALE'));
});

describe('#519 replay derives recall state', () => {
  it('requires the recall set in every signed safety lease', () => {
    const body = command();
    const lease: Partial<typeof body.snapshots[0]['envelope']['safetyLease']> = {
      ...body.snapshots[0]!.envelope.safetyLease,
    };
    delete lease.recalledBatchIds;
    const missing = {
      ...body,
      snapshots: [
        { ...body.snapshots[0]!, envelope: { ...body.snapshots[0]!.envelope, safetyLease: lease } },
      ],
    };
    expect(router.counterReplaySchema.safeParse(missing).success).toBe(false);
  });

  it('refuses a lot the signed lease told the counter was recalled', async () => {
    const target = db([{ id: 'lot_1', batch: { state: 'ACTIVE' } }]);
    await expect(replay(target.db, command(['lot_1']))).rejects.toMatchObject({
      reason: 'ACTION_DENIED',
    });
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('refuses a lot whose batch the server holds as recalled now', async () => {
    const target = db([{ id: 'lot_1', batch: { state: 'RECALLED' } }]);
    await expect(replay(target.db)).rejects.toMatchObject({ reason: 'ACTION_DENIED' });
    expect(target.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', branchId: 'branch_a', id: { in: ['lot_1'] } },
      select: { id: true, batch: { select: { state: true } } },
    });
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('fails closed on a lot the server cannot see in this branch', async () => {
    const target = db([]);
    await expect(replay(target.db)).rejects.toMatchObject({ reason: 'ACTION_DENIED' });
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('lets an unrecalled lot proceed to the sale', async () => {
    const target = db([{ id: 'lot_1', batch: { state: 'ACTIVE' } }]);
    await expect(replay(target.db)).rejects.toThrow('REACHED_SALE');
  });

  it('still returns an already accepted sale on retry after a later recall', async () => {
    mocks.recordOfflineCommand.mockResolvedValue({
      command: { id: 'cmd_1', status: 'ACCEPTED', serverRef: 'sale_1', receiptNumber: 900 },
    });
    const target = db([{ id: 'lot_1', batch: { state: 'RECALLED' } }]);
    await expect(replay(target.db)).resolves.toEqual({
      saleId: 'sale_1',
      receiptNumber: 900,
      replayed: true,
    });
  });
});

describe('DEV-825 replay takes stock locks in the global order', () => {
  it("locks every line's batch, then every candidate balance, before the first line", async () => {
    mocks.createSale.mockResolvedValue({ id: 'sale_1' });
    const base = command();
    const body = router.counterReplaySchema.parse({
      ...base,
      lines: [
        { ...base.lines[0]!, medicineId: 'med_2', inventoryLotId: 'lot_2' },
        { ...base.lines[0]!, medicineId: 'med_1', inventoryLotId: 'lot_1' },
      ],
    });
    const target = db([
      { id: 'lot_1', batch: { state: 'ACTIVE' } },
      { id: 'lot_2', batch: { state: 'ACTIVE' } },
    ]);
    const firstLine = vi.fn(async () => {
      throw new Error('REACHED_LINES');
    });
    Object.assign(target.db, { medicine: { findFirst: firstLine } });
    await expect(replay(target.db, body)).rejects.toThrow('REACHED_LINES');

    const raw = vi.mocked(target.db.$queryRaw);
    const statements = raw.mock.calls.map(
      ([sql]) => sql as unknown as { strings: string[]; values: unknown[] }
    );
    const batchLock = statements.findIndex((sql) =>
      sql.strings?.join('').includes('stock_lock:batch')
    );
    const balanceLock = statements.findIndex((sql) =>
      sql.strings?.join('').includes('stock_lock:balance')
    );
    expect(batchLock).toBeGreaterThanOrEqual(0);
    expect(statements[batchLock]!.strings.join('')).toContain('FOR SHARE');
    expect(statements[batchLock]!.values).toEqual(expect.arrayContaining(['lot_1', 'lot_2']));
    expect(balanceLock).toBeGreaterThan(batchLock);
    expect(statements[balanceLock]!.values).toEqual(expect.arrayContaining(['med_1', 'med_2']));
    expect(raw.mock.invocationCallOrder[balanceLock]).toBeLessThan(
      firstLine.mock.invocationCallOrder[0]!
    );
  });
});
