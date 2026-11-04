// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrintDocument } from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { buildPrinterTestPrintJob } from './printer-test-escpos';

import {
  acknowledgePharmacyPrintJob,
  claimNextPharmacyPrintJob,
  derivePrintJobState,
  enqueuePharmacyReceiptPrint,
  enqueuePharmacyTestPagePrint,
  enrollPharmacyPrintBridge,
  formatPharmacyPrintBridgeCredential,
  isValidPrinterTarget,
  parsePharmacyPrintBridgeCredential,
  PharmacyPrintQueueError,
  PRINT_BRIDGE_ONLINE_MS,
  PRINT_CLAIM_LEASE_MS,
  PRINT_QUEUE_TTL_MS,
  printJobView,
  resolvePharmacyPrintBridge,
  retryPharmacyPrintJob,
  revokePharmacyPrintBridge,
} from './receipt-print-queue';

/**
 * Behaviour of the queue rules against a small in-memory store that evaluates
 * the same `where` predicates Prisma would. The database guards (triggers,
 * partial unique index, RLS) are covered by the migration itself and are NOT
 * proven here; see the PR for what was and was not run against PostgreSQL.
 */

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date)
      return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === 'object' && condition && 'gt' in condition) {
      return value instanceof Date && value.getTime() > (condition.gt as Date).getTime();
    }
    return value === condition;
  });
}

function table(unique: (row: Row) => string[], defaults: Row) {
  const rows: Row[] = [];
  let nextId = 1;
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const [key, value] = Object.entries(where)[0]!;
      if (typeof value === 'object' && value) {
        return rows.find((row) => matches(row, value as Row)) ?? null;
      }
      return rows.find((row) => row[key] === value) ?? null;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null
    ),
    findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where))),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `id_${nextId++}`,
        createdAt: new Date(),
        ...defaults,
        ...data,
      };
      for (const key of unique(row)) {
        if (rows.some((other) => unique(other).includes(key))) throw new Error(`unique ${key}`);
      }
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const key = Object.values(where)[0] as Row;
      const row = rows.find((candidate) => matches(candidate, key));
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = rows.filter((row) => matches(row, where));
      hits.forEach((row) => Object.assign(row, data));
      return { count: hits.length };
    }),
  };
}

const ORG = 'org_pharmacy_a';
const BRANCH = 'branch_a';
const ACTOR = 'user_cashier';
const T0 = new Date('2026-11-04T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function fakeDb() {
  const pharmacyPrintBridge = table((row) => [`hash:${row.deviceSecretHash}`], {
    status: 'ACTIVE',
    revokedAt: null,
    lastSeenAt: null,
  });
  const pharmacyPrintJob = table(
    (row) => [
      `key:${row.organizationId}:${row.branchId}:${row.idempotencyKey}`,
      // Mirrors the partial unique index: PostgreSQL never matches NULL sale ids, so
      // sale-less TEST_PAGE jobs (DEV-742) never collide on it.
      ...(row.reprint === false && row.saleId != null
        ? [`original:${row.organizationId}:${row.branchId}:${row.saleId}`]
        : []),
    ],
    {
      status: 'PENDING',
      attemptCount: 0,
      lastAttemptAt: null,
      acceptedAt: null,
      failureCode: null,
      retriedByActorId: null,
    }
  );
  const $executeRawUnsafe = vi.fn(async () => 0);
  return { pharmacyPrintBridge, pharmacyPrintJob, $executeRawUnsafe } as unknown as ScopedDb & {
    pharmacyPrintBridge: ReturnType<typeof table>;
    pharmacyPrintJob: ReturnType<typeof table>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
  };
}

const document: PrintDocument = {
  type: 'RECEIPT',
  reference: 'receipt:41',
  title: 'Receipt 41',
  createdAt: T0.toISOString(),
  lines: [{ quantity: 1, label: 'Panadol - 500 mg - Tablet' }],
  receiptSnapshot: {
    layout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 },
    facts: {
      businessName: 'Branch A',
      invoiceNumber: 'Receipt 41',
      issuedAt: 'Date: 2026-11-04',
      lines: ['Panadol\n1 x 100.00\nLine total: 100.00'],
      taxLines: ['Tax breakdown unavailable in receipt source'],
      totals: ['PKR', 'Net: 100.00'],
      payments: ['CASH: 100.00'],
    },
  },
};
const byteCount = renderEscPos(document).length;

async function onlineBridge(db: ReturnType<typeof fakeDb>, printerId = 'tcp://192.0.2.10:9100') {
  const { bridge, credential } = await enrollPharmacyPrintBridge(
    db,
    { organizationId: ORG, branchId: BRANCH, actorId: 'user_admin' },
    { name: 'Front counter', printerId }
  );
  (bridge as { lastSeenAt: Date | null }).lastSeenAt = T0;
  return { bridge, credential };
}

function enqueue(db: ReturnType<typeof fakeDb>, overrides: Record<string, unknown> = {}) {
  return enqueuePharmacyReceiptPrint(db, {
    organizationId: ORG,
    branchId: BRANCH,
    actorId: ACTOR,
    saleId: 'sale_41',
    receiptNumber: 41,
    reprint: false,
    document,
    byteCount,
    paperWidth: 58,
    now: T0,
    ...overrides,
  });
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'test-auth-secret-for-print-claims');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bridge credential and printer target', () => {
  it('round-trips the organization hint and refuses malformed or non-canonical credentials', () => {
    const secret = `ppb_${'B'.repeat(43)}`;
    const credential = formatPharmacyPrintBridgeCredential(secret, ORG);
    expect(parsePharmacyPrintBridgeCredential(credential)).toEqual({ secret, organizationId: ORG });
    expect(parsePharmacyPrintBridgeCredential(secret)).toBeNull();
    expect(parsePharmacyPrintBridgeCredential(`pcd_${'B'.repeat(43)}.b3Jn`)).toBeNull();
    expect(parsePharmacyPrintBridgeCredential(`rdk_${'B'.repeat(43)}`)).toBeNull();
    // Decodes to a value with characters outside the organization id grammar.
    const odd = Buffer.from('org/../x').toString('base64url');
    expect(parsePharmacyPrintBridgeCredential(`${secret}.${odd}`)).toBeNull();
  });

  it('accepts explicit host targets for any supported host and rejects everything else', () => {
    expect(isValidPrinterTarget('tcp://192.0.2.10:9100')).toBe(true);
    expect(isValidPrinterTarget('queue:///Receipt_Printer')).toBe(true);
    expect(isValidPrinterTarget('/dev/usb/lp0')).toBe(true);
    expect(isValidPrinterTarget('tcp://user:pass@192.0.2.10:9100')).toBe(false);
    expect(isValidPrinterTarget('http://printer.local')).toBe(false);
    expect(isValidPrinterTarget('queue:///Receipt Printer')).toBe(false);
    expect(isValidPrinterTarget('')).toBe(false);
  });

  it('stores only the secret hash and resolves only inside the credential tenant', async () => {
    const db = fakeDb();
    const { bridge, credential } = await onlineBridge(db);
    expect(JSON.stringify(db.pharmacyPrintBridge.rows)).not.toContain(credential.split('.')[0]);
    const parsed = parsePharmacyPrintBridgeCredential(credential)!;
    expect((await resolvePharmacyPrintBridge(db, parsed))?.id).toBe(bridge.id);
    expect(
      await resolvePharmacyPrintBridge(db, { ...parsed, organizationId: 'org_other' })
    ).toBeNull();
  });

  it('refuses an invalid printer target or name at enrollment', async () => {
    const db = fakeDb();
    const scope = { organizationId: ORG, branchId: BRANCH, actorId: 'user_admin' };
    await expect(
      enrollPharmacyPrintBridge(db, scope, { name: 'x', printerId: 'smb://share/printer' })
    ).rejects.toMatchObject({ reason: 'INVALID_PRINTER' });
    await expect(
      enrollPharmacyPrintBridge(db, scope, { name: '  ', printerId: 'tcp://192.0.2.10' })
    ).rejects.toMatchObject({ reason: 'INVALID_NAME' });
  });
});

describe('enqueue duplicate protection and fallback', () => {
  it('queues one original per sale and replays the same job on a repeated click', async () => {
    const db = fakeDb();
    await onlineBridge(db);
    const first = await enqueue(db);
    const second = await enqueue(db);
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, job: { id: first.job.id } });
    expect(db.pharmacyPrintJob.rows).toHaveLength(1);
    expect(first.job).toMatchObject({
      idempotencyKey: 'sale:sale_41:original',
      printerId: 'tcp://192.0.2.10:9100',
      paperWidth: 58,
      byteCount,
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      `pharmacy-print:${ORG}:${BRANCH}:sale_41`
    );
  });

  it('requires a per-click key for reprints and keeps each reprint separate', async () => {
    const db = fakeDb();
    await onlineBridge(db);
    await expect(enqueue(db, { reprint: true })).rejects.toMatchObject({
      reason: 'REPRINT_KEY_REQUIRED',
    });
    const a = await enqueue(db, { reprint: true, requestKey: 'click-0001' });
    const again = await enqueue(db, { reprint: true, requestKey: 'click-0001' });
    const b = await enqueue(db, { reprint: true, requestKey: 'click-0002' });
    expect(again.job.id).toBe(a.job.id);
    expect(b.job.id).not.toBe(a.job.id);
    expect(db.pharmacyPrintJob.rows.map((row) => row.reprint)).toEqual([true, true]);
  });

  it('never queues for a missing, offline, revoked or ambiguous bridge', async () => {
    const db = fakeDb();
    await expect(enqueue(db)).rejects.toMatchObject({ reason: 'NO_BRIDGE' });
    const { bridge } = await onlineBridge(db);
    (bridge as { lastSeenAt: Date | null }).lastSeenAt = at(-PRINT_BRIDGE_ONLINE_MS);
    await expect(enqueue(db)).rejects.toMatchObject({ reason: 'BRIDGE_OFFLINE' });
    await revokePharmacyPrintBridge(db, { organizationId: ORG, branchId: BRANCH }, bridge.id, T0);
    await expect(enqueue(db)).rejects.toMatchObject({ reason: 'NO_BRIDGE' });
    const two = await onlineBridge(db);
    await onlineBridge(db, 'queue:///Second_Printer');
    await expect(enqueue(db)).rejects.toMatchObject({ reason: 'BRIDGE_REQUIRED' });
    await expect(enqueue(db, { bridgeId: two.bridge.id })).resolves.toMatchObject({
      replayed: false,
    });
    await expect(
      enqueue(db, { reprint: true, requestKey: 'click-0003', bridgeId: bridge.id })
    ).rejects.toMatchObject({ reason: 'BRIDGE_NOT_FOUND' });
    expect(db.pharmacyPrintJob.rows).toHaveLength(1);
  });
});

describe('claim, acknowledgement and honest state', () => {
  async function queued() {
    const db = fakeDb();
    const { bridge } = await onlineBridge(db);
    const { job } = await enqueue(db);
    return { db, bridge, job };
  }

  it('offers a job once, with server-rendered bytes, and only to its own bridge', async () => {
    const { db, bridge, job } = await queued();
    const other = await onlineBridge(db, 'queue:///Other');
    expect(await claimNextPharmacyPrintJob(db, other.bridge, at(1_000))).toBeNull();
    const claim = await claimNextPharmacyPrintJob(db, bridge, at(1_000));
    expect(claim).toMatchObject({
      id: job.id,
      attempt: 1,
      documentType: 'RECEIPT',
      paperWidth: 58,
    });
    expect(Buffer.from(claim!.bytes, 'base64')).toEqual(Buffer.from(renderEscPos(document)));
    expect(claim!.claimToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await claimNextPharmacyPrintJob(db, bridge, at(2_000))).toBeNull();
    expect(derivePrintJobState(db.pharmacyPrintJob.rows[0] as never, at(2_000))).toBe('SENDING');
  });

  it('records transport acceptance without ever confirming paper', async () => {
    const { db, bridge } = await queued();
    const claim = (await claimNextPharmacyPrintJob(db, bridge, at(1_000)))!;
    const ack = await acknowledgePharmacyPrintJob(db, bridge, {
      jobId: claim.id,
      claimToken: claim.claimToken,
      outcome: 'TRANSPORT_ACCEPTED',
      now: at(2_000),
    });
    expect(ack).toEqual({ acknowledged: true, replayed: false });
    const view = printJobView(db.pharmacyPrintJob.rows[0] as never, at(3_000));
    expect(view).toMatchObject({
      state: 'SENT_TO_PRINTER',
      paperConfirmed: false,
      retryable: false,
    });
    // Replayed acknowledgement is idempotent; a forged token is rejected.
    await expect(
      acknowledgePharmacyPrintJob(db, bridge, {
        jobId: claim.id,
        claimToken: claim.claimToken,
        outcome: 'TRANSPORT_ACCEPTED',
        now: at(4_000),
      })
    ).resolves.toEqual({ acknowledged: true, replayed: true });
    await expect(
      acknowledgePharmacyPrintJob(db, bridge, {
        jobId: claim.id,
        claimToken: 'f'.repeat(64),
        outcome: 'FAILED',
        now: at(4_000),
      })
    ).resolves.toEqual({ acknowledged: false, replayed: false });
  });

  it('rejects an acknowledgement from another bridge even with the right token', async () => {
    const { db, bridge } = await queued();
    const other = await onlineBridge(db, 'queue:///Other');
    const claim = (await claimNextPharmacyPrintJob(db, bridge, at(1_000)))!;
    await expect(
      acknowledgePharmacyPrintJob(db, other.bridge, {
        jobId: claim.id,
        claimToken: claim.claimToken,
        outcome: 'TRANSPORT_ACCEPTED',
        now: at(2_000),
      })
    ).resolves.toEqual({ acknowledged: false, replayed: false });
  });

  it('shows an unanswered claim as UNCONFIRMED and an unclaimed stale job as EXPIRED', async () => {
    const { db, bridge } = await queued();
    expect(derivePrintJobState(db.pharmacyPrintJob.rows[0] as never, at(PRINT_QUEUE_TTL_MS))).toBe(
      'EXPIRED'
    );
    // A stale job is never offered late.
    expect(await claimNextPharmacyPrintJob(db, bridge, at(PRINT_QUEUE_TTL_MS))).toBeNull();
    const fresh = await queued();
    await claimNextPharmacyPrintJob(fresh.db, fresh.bridge, at(1_000));
    const view = printJobView(
      fresh.db.pharmacyPrintJob.rows[0] as never,
      at(1_000 + PRINT_CLAIM_LEASE_MS)
    );
    expect(view).toMatchObject({
      state: 'UNCONFIRMED',
      retryable: true,
      retryRequiresPaperCheck: true,
    });
  });

  it('fails a job whose stored document no longer renders to the stored bytes, without dispatch', async () => {
    const { db, bridge } = await queued();
    db.pharmacyPrintJob.rows[0]!.byteCount = byteCount + 1;
    expect(await claimNextPharmacyPrintJob(db, bridge, at(1_000))).toBeNull();
    expect(db.pharmacyPrintJob.rows[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_DOCUMENT',
    });
  });
});

describe('operator retry', () => {
  const scope = { organizationId: ORG, branchId: BRANCH, actorId: 'user_cashier_2' };

  it('requires a paper check after FAILED and invalidates the old claim token', async () => {
    const db = fakeDb();
    const { bridge } = await onlineBridge(db);
    await enqueue(db);
    const claim = (await claimNextPharmacyPrintJob(db, bridge, at(1_000)))!;
    await acknowledgePharmacyPrintJob(db, bridge, {
      jobId: claim.id,
      claimToken: claim.claimToken,
      outcome: 'FAILED',
      failureCode: 'TRANSPORT_FAILED',
      now: at(2_000),
    });
    await expect(
      retryPharmacyPrintJob(db, scope, { jobId: claim.id, paperChecked: false, now: at(3_000) })
    ).rejects.toMatchObject({ reason: 'PAPER_CHECK_REQUIRED' });
    const retried = await retryPharmacyPrintJob(db, scope, {
      jobId: claim.id,
      paperChecked: true,
      now: at(3_000),
    });
    expect(retried).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      retriedByActorId: 'user_cashier_2',
      failureCode: null,
    });
    const second = (await claimNextPharmacyPrintJob(db, bridge, at(4_000)))!;
    expect(second.attempt).toBe(2);
    expect(second.claimToken).not.toBe(claim.claimToken);
    // The first attempt's token can no longer change the job.
    await expect(
      acknowledgePharmacyPrintJob(db, bridge, {
        jobId: claim.id,
        claimToken: claim.claimToken,
        outcome: 'TRANSPORT_ACCEPTED',
        now: at(5_000),
      })
    ).resolves.toEqual({ acknowledged: false, replayed: false });
  });

  it('refuses to retry work in flight or already accepted, and needs no paper check after EXPIRED', async () => {
    const db = fakeDb();
    const { bridge } = await onlineBridge(db);
    const { job } = await enqueue(db);
    await expect(
      retryPharmacyPrintJob(db, scope, { jobId: job.id, paperChecked: true, now: at(1_000) })
    ).rejects.toMatchObject({ reason: 'NOT_RETRYABLE' });
    (bridge as { lastSeenAt: Date | null }).lastSeenAt = at(PRINT_QUEUE_TTL_MS);
    await expect(
      retryPharmacyPrintJob(db, scope, {
        jobId: job.id,
        paperChecked: false,
        now: at(PRINT_QUEUE_TTL_MS),
      })
    ).resolves.toMatchObject({ status: 'PENDING' });
    const claim = (await claimNextPharmacyPrintJob(db, bridge, at(PRINT_QUEUE_TTL_MS + 1)))!;
    await acknowledgePharmacyPrintJob(db, bridge, {
      jobId: claim.id,
      claimToken: claim.claimToken,
      outcome: 'TRANSPORT_ACCEPTED',
      now: at(PRINT_QUEUE_TTL_MS + 2),
    });
    await expect(
      retryPharmacyPrintJob(db, scope, {
        jobId: job.id,
        paperChecked: true,
        now: at(PRINT_QUEUE_TTL_MS + 3),
      })
    ).rejects.toMatchObject({ reason: 'NOT_RETRYABLE' });
  });

  it('refuses to retry onto an offline or revoked bridge', async () => {
    const db = fakeDb();
    const { bridge } = await onlineBridge(db);
    const { job } = await enqueue(db);
    const later = at(PRINT_QUEUE_TTL_MS);
    await expect(
      retryPharmacyPrintJob(db, scope, { jobId: job.id, paperChecked: false, now: later })
    ).rejects.toMatchObject({ reason: 'BRIDGE_OFFLINE' });
    await revokePharmacyPrintBridge(db, scope, bridge.id, later);
    await expect(
      retryPharmacyPrintJob(db, scope, { jobId: job.id, paperChecked: false, now: later })
    ).rejects.toBeInstanceOf(PharmacyPrintQueueError);
  });
});

describe('DEV-742 thermal test-page jobs', () => {
  const testJob = buildPrinterTestPrintJob({ paperWidth: 58, now: T0 });
  function enqueueTest(db: ReturnType<typeof fakeDb>, overrides: Record<string, unknown> = {}) {
    return enqueuePharmacyTestPagePrint(db, {
      organizationId: ORG,
      branchId: BRANCH,
      actorId: ACTOR,
      requestKey: 'test-click-0001',
      document: testJob.document,
      byteCount: testJob.byteCount,
      paperWidth: 58,
      now: T0,
      ...overrides,
    });
  }

  it('queues a sale-less, never-reprint TEST_PAGE job and replays the same click', async () => {
    const db = fakeDb();
    await onlineBridge(db);
    const first = await enqueueTest(db);
    const replay = await enqueueTest(db);
    const second = await enqueueTest(db, { requestKey: 'test-click-0002' });
    expect(first.job).toMatchObject({
      kind: 'TEST_PAGE',
      saleId: null,
      receiptNumber: null,
      reprint: false,
      idempotencyKey: 'test:test-click-0001',
      paperWidth: 58,
    });
    expect(replay).toMatchObject({ replayed: true, job: { id: first.job.id } });
    expect(second.job.id).not.toBe(first.job.id);
    expect(printJobView(first.job as never, T0)).toMatchObject({
      kind: 'TEST_PAGE',
      saleId: null,
      receiptNumber: null,
      state: 'QUEUED',
      paperConfirmed: false,
    });
  });

  it('never lets a test page and a receipt share a key or block the original receipt', async () => {
    const db = fakeDb();
    await onlineBridge(db);
    await enqueueTest(db);
    const receipt = await enqueue(db);
    expect(receipt.replayed).toBe(false);
    expect(receipt.job).toMatchObject({ kind: 'RECEIPT', saleId: 'sale_41' });
    expect(db.pharmacyPrintJob.rows.map((row) => row.kind)).toEqual(['TEST_PAGE', 'RECEIPT']);
  });

  it('refuses a missing or offline bridge and an invalid click key, queueing nothing', async () => {
    const db = fakeDb();
    await expect(enqueueTest(db)).rejects.toMatchObject({ reason: 'NO_BRIDGE' });
    const { bridge } = await onlineBridge(db);
    (bridge as { lastSeenAt: Date | null }).lastSeenAt = at(-PRINT_BRIDGE_ONLINE_MS);
    await expect(enqueueTest(db)).rejects.toMatchObject({ reason: 'BRIDGE_OFFLINE' });
    await expect(enqueueTest(db, { requestKey: 'bad key!' })).rejects.toBeInstanceOf(
      PharmacyPrintQueueError
    );
    expect(db.pharmacyPrintJob.rows).toHaveLength(0);
  });

  it('is claimed once through the normal bridge path with the stored bytes', async () => {
    const db = fakeDb();
    const { bridge } = await onlineBridge(db);
    await enqueueTest(db);
    const claimed = await claimNextPharmacyPrintJob(db, bridge, at(1_000));
    expect(claimed).toMatchObject({ documentType: 'RECEIPT', attempt: 1, paperWidth: 58 });
    expect(Buffer.from(claimed!.bytes, 'base64')).toHaveLength(testJob.byteCount);
    await expect(claimNextPharmacyPrintJob(db, bridge, at(2_000))).resolves.toBeNull();
  });
});
