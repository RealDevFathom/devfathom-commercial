// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { SAMPLE_RECEIPT } from '@/lib/receipts/preview';
import {
  PrintDocumentSchema,
  PrintJobRequestSchema,
  StoredPrintDocumentSchema,
  type PrintDocument,
  type PrintJob,
  type PrintRoute,
} from './contract';
import { renderEscPos } from './esc-pos';
import { acknowledgePrintJob, claimNextPrintJob, PrintBridgeService } from './service';

const now = new Date('2026-10-14T07:00:00Z');
const label = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
const document: PrintDocument = {
  type: 'KITCHEN_TICKET',
  title: 'Kitchen',
  reference: 'K-1',
  createdAt: now.toISOString(),
  lines: [{ quantity: 12, label }],
  footer: 'Done',
};
const job: PrintJob = {
  branchId: 'branch',
  stationId: null,
  idempotencyKey: 'width-intent',
  document,
};
const route: PrintRoute = {
  documentType: 'KITCHEN_TICKET',
  stationId: null,
  printerId: 'tcp://printer:9100',
  registeredPrinterId: 'printer',
  enabled: true,
};
const expected = { printerId: route.printerId, registeredPrinterId: 'printer' };
const baseRow = {
  id: 'job',
  organizationId: 'org',
  branchId: 'branch',
  printerId: route.printerId,
  registeredPrinterId: 'printer',
  documentType: document.type,
  document,
  status: 'PENDING',
  attemptCount: 0,
  lastAttemptAt: null,
};
function makeDb() {
  let inventoryWidth: unknown = 58;
  let eligible = true;
  return {
    setWidth(value: unknown) {
      inventoryWidth = value;
    },
    setEligible(value: boolean) {
      eligible = value;
    },
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'branch', active: true }]),
    restaurantPrintRoute: { findMany: vi.fn().mockResolvedValue([route]) },
    restaurantPrinter: {
      // Projection-aware: selecting only an id cannot accidentally expose width.
      findFirst: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
        if (!eligible) return null;
        return Object.fromEntries(
          Object.entries({ id: 'printer', paperWidthMm: inventoryWidth }).filter(
            ([key]) => select[key]
          )
        );
      }),
    },
    restaurantPrintJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([baseRow]),
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;
const enqueue = (input = job, target = route) =>
  new PrintBridgeService(scoped()).enqueue('org', { branchId: 'branch', routes: [target] }, input);
const persisted = () => db.restaurantPrintJob.create.mock.calls[0][0].data.document;
const withWidth = (paperWidthMm: 58 | 80) => ({
  ...document,
  ticketPrintSnapshot: { paperWidthMm },
});
// Independent wire fixtures retain ESC/POS commands and hard-wrap expectations.
function expectedWire(width: 58 | 80) {
  const divider =
    width === 58
      ? '--------------------------------'
      : '------------------------------------------------';
  const item =
    width === 58
      ? '12 x\nABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n6789abcdefghijklmnopqrstuvwxyz'
      : '12 x\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl\nmnopqrstuvwxyz';
  return Buffer.from(
    `\x1b@\x1ba\x01\x1bE\x01Kitchen\nK-1\n\x1bE\x00\x1ba\x00${divider}\n${item}\n${divider}\nDone\n\n\n\n\x1dV\x00`,
    'ascii'
  );
}
beforeEach(() => {
  db = makeDb();
  vi.stubEnv('AUTH_SECRET', 'synthetic-width-claim-test-key');
});
afterEach(() => vi.unstubAllEnvs());

describe('server-owned new ticket snapshots', () => {
  it.each([
    ['KITCHEN_TICKET', 58],
    ['KITCHEN_TICKET', 80],
    ['BAR_TICKET', 58],
    ['BAR_TICKET', 80],
  ] as const)('snapshots %s width %i from one scoped observation', async (type, width) => {
    db.setWidth(width);
    const input = { ...job, document: { ...document, type } };
    const original = structuredClone(input);
    await expect(enqueue(input, { ...route, documentType: type })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(input).toEqual(original);
    expect(persisted()).toEqual({
      ...input.document,
      ticketPrintSnapshot: { paperWidthMm: width },
    });
    expect(db.restaurantPrinter.findFirst).toHaveBeenCalledTimes(1);
    expect(db.restaurantPrinter.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'printer',
        organizationId: 'org',
        branchId: 'branch',
        address: route.printerId,
        branch: { is: { active: true } },
        bridge: {
          is: {
            organizationId: 'org',
            branchId: 'branch',
            kind: 'PRINT_BRIDGE',
            status: 'ACTIVE',
            revokedAt: null,
          },
        },
      },
      select: { id: true, paperWidthMm: true },
    });
  });
  it('keeps expected-destination comparison ahead of width lookup and stores a matching guarded snapshot', async () => {
    const service = new PrintBridgeService(scoped());
    await expect(
      service.enqueue('org', { branchId: 'branch', routes: [] }, job, {
        ...expected,
        printerId: 'stale',
      })
    ).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    await expect(
      service.enqueue('org', { branchId: 'branch', routes: [] }, job, expected)
    ).resolves.toMatchObject({ status: 'QUEUED' });
    expect(persisted().ticketPrintSnapshot).toEqual({ paperWidthMm: 58 });
    expect(db.restaurantPrintRoute.findMany.mock.invocationCallOrder[1]).toBeLessThan(
      db.restaurantPrinter.findFirst.mock.invocationCallOrder[0]
    );
  });
  it.each([59, null, '58', undefined])(
    'fails closed for invalid inventory width %s',
    async (width) => {
      db.setWidth(width);
      await expect(enqueue()).resolves.toMatchObject({ status: 'NO_PRINTER' });
      await expect(
        new PrintBridgeService(scoped()).enqueue(
          'org',
          { branchId: 'branch', routes: [] },
          job,
          expected
        )
      ).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
      expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
    }
  );
  it('does not create a snapshot when the scoped destination is unavailable', async () => {
    db.setEligible(false);
    await expect(enqueue()).resolves.toMatchObject({ status: 'NO_PRINTER' });
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied ticket metadata in document, HTTP request and direct enqueue', async () => {
    const forged = { ...job, document: withWidth(80) };
    expect(PrintDocumentSchema.safeParse(forged.document).success).toBe(false);
    expect(
      PrintJobRequestSchema.safeParse({ ...forged, expectedDestination: expected }).success
    ).toBe(false);
    await expect(enqueue(forged)).rejects.toMatchObject({ code: 'INVALID_PRINT_DOCUMENT' });
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
  it('does not widen synchronous legacy delivery to caller-supplied metadata on a prior job', async () => {
    db.restaurantPrintJob.findUnique.mockResolvedValue({ ...baseRow, registeredPrinterId: null });
    const send = vi.fn();
    await expect(
      new PrintBridgeService({ kind: 'test', send }, scoped()).submit(
        'org',
        { branchId: 'branch', routes: [{ ...route, registeredPrinterId: null }] },
        { ...job, document: withWidth(80) }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PRINT_DOCUMENT' });
    expect(send).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.update).not.toHaveBeenCalled();
  });
  it('retains legacy unregistered documents without looking up or inventing width', async () => {
    db.setWidth(80);
    await enqueue(job, { ...route, registeredPrinterId: null });
    expect(persisted()).toEqual(document);
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    const wire = Buffer.from(renderEscPos(persisted())).toString('ascii');
    expect(wire).toContain(`12 x ${label}\n`);
    expect(wire).toContain('--------------------------------\n');
  });
  it.each([58, 80] as const)(
    'keeps receipt documents and bytes unchanged at inventory width %i',
    async (width) => {
      db.setWidth(width);
      for (const receiptSnapshot of [
        undefined,
        { layout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 as const }, facts: SAMPLE_RECEIPT },
      ]) {
        const receipt = {
          ...document,
          type: 'RECEIPT' as const,
          ...(receiptSnapshot ? { receiptSnapshot } : {}),
        };
        const before = renderEscPos(receipt);
        db.restaurantPrintJob.create.mockClear();
        await enqueue({ ...job, document: receipt }, { ...route, documentType: 'RECEIPT' });
        expect(persisted()).toEqual(receipt);
        expect(renderEscPos(persisted())).toEqual(before);
        expect(persisted()).not.toHaveProperty('ticketPrintSnapshot');
        expect(db.restaurantPrinter.findFirst).toHaveBeenLastCalledWith({
          where: expect.objectContaining({ id: 'printer', address: route.printerId }),
          select: { id: true },
        });
      }
    }
  );
});

describe('immutable stored ticket output', () => {
  it.each([58, 80] as const)('matches independent %imm wire bytes', (width) => {
    expect(Buffer.from(renderEscPos(withWidth(width)))).toEqual(expectedWire(width));
  });
  it.each([58, 80] as const)('wraps long title, reference and footer at %imm', (width) => {
    const columns = width === 58 ? 32 : 48;
    const input = {
      ...withWidth(width),
      title: 'T'.repeat(70),
      reference: 'R'.repeat(70),
      footer: 'F'.repeat(100),
    };
    const wire = Buffer.from(renderEscPos(input));
    const body = wire
      .subarray(8, wire.length - 3)
      .toString('ascii')
      .replace('\x1bE\x00\x1ba\x00', '');
    expect(body.split('\n').every((line) => line.length <= columns)).toBe(true);
    for (const [letter, length] of [
      ['T', 70],
      ['R', 70],
      ['F', 100],
    ] as const)
      expect([...body].filter((char) => char === letter)).toHaveLength(length + 1);
  });
  it.each([58, 80] as const)(
    'preserves boundary content and embedded blank lines at %imm',
    (width) => {
      const columns = width === 58 ? 32 : 48;
      for (const count of [columns - 1, columns, columns + 1]) {
        const title = 'Z'.repeat(count);
        const wire = Buffer.from(renderEscPos({ ...withWidth(width), title })).toString('ascii');
        const expectedTitle = count > columns ? `${'Z'.repeat(columns)}\nZ` : title;
        expect(wire).toContain(`\x1bE\x01${expectedTitle}\nK-1\n`);
      }
      const footer = `${'A'.repeat(columns)} B\n\nC  D`;
      const wire = Buffer.from(renderEscPos({ ...withWidth(width), footer })).toString('ascii');
      expect(wire).toContain(`${'A'.repeat(columns)}\nB\n\nC  D\n`);
    }
  );
  it.each(['PENDING', 'OFFLINE', 'PRINTED'])(
    'replays the prior %s snapshot without inventory reads or writes',
    async (status) => {
      const saved = withWidth(58);
      db.restaurantPrintJob.findUnique.mockResolvedValue({
        ...baseRow,
        document: saved,
        status,
        byteCount: expectedWire(58).length,
      });
      db.setWidth(80);
      await expect(enqueue()).resolves.toMatchObject({
        replayed: true,
        printerId: route.printerId,
      });
      expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
      expect(db.restaurantPrintJob.update).not.toHaveBeenCalled();
      expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
      expect(Buffer.from(renderEscPos(saved))).toEqual(expectedWire(58));
    }
  );
  it('replays an old registered job without backfilling ticket metadata', async () => {
    db.restaurantPrintJob.findUnique.mockResolvedValue(baseRow);
    await expect(enqueue()).resolves.toMatchObject({ replayed: true });
    expect(baseRow.document).not.toHaveProperty('ticketPrintSnapshot');
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.update).not.toHaveBeenCalled();
  });
  it.each([58, 80] as const)(
    'claims and acknowledges saved %imm bytes after inventory changes',
    async (width) => {
      const row = { ...baseRow, document: withWidth(width) };
      db.restaurantPrintJob.findMany.mockResolvedValue([row]);
      db.setWidth(width === 58 ? 80 : 58);
      const claim = await claimNextPrintJob(scoped(), 'branch', 'bridge', now);
      expect(Buffer.from(claim!.bytes, 'base64')).toEqual(expectedWire(width));
      db.restaurantPrintJob.findFirst.mockResolvedValue({
        ...row,
        attemptCount: 1,
        lastAttemptAt: now,
      });
      const ack = {
        branchId: 'branch',
        deviceId: 'bridge',
        jobId: 'job',
        claimToken: claim!.claimToken,
        status: 'PRINTED' as const,
        now: new Date(now.getTime() + 1000),
      };
      expect(await acknowledgePrintJob(scoped(), ack)).toEqual({
        acknowledged: true,
        replayed: false,
      });
      expect(db.restaurantPrintJob.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'job',
          branchId: 'branch',
          status: 'PENDING',
          attemptCount: 1,
          lastAttemptAt: now,
        },
        data: { status: 'PRINTED', byteCount: expectedWire(width).length, printedAt: ack.now },
      });
      db.restaurantPrintJob.findFirst.mockResolvedValue({
        ...row,
        status: 'PRINTED',
        attemptCount: 1,
        lastAttemptAt: now,
      });
      expect(await acknowledgePrintJob(scoped(), ack)).toEqual({
        acknowledged: true,
        replayed: true,
      });
      expect(db.restaurantPrintJob.updateMany).toHaveBeenCalledTimes(2);
      expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    }
  );
  it.each([
    null,
    {},
    { paperWidthMm: 59 },
    { paperWidthMm: '58' },
    { paperWidthMm: 58, extra: true },
  ])(
    'holds malformed stored metadata %j before dispatch without changing the document',
    async (ticketPrintSnapshot) => {
      const invalid = { ...document, ticketPrintSnapshot };
      expect(StoredPrintDocumentSchema.safeParse(invalid).success).toBe(false);
      db.restaurantPrintJob.findMany.mockResolvedValue([{ ...baseRow, document: invalid }]);
      expect(await claimNextPrintJob(scoped(), 'branch', 'bridge', now)).toBeNull();
      expect(db.restaurantPrintJob.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'job',
          status: 'PENDING',
          attemptCount: 0,
          lastAttemptAt: null,
        }),
        data: { status: 'OFFLINE' },
      });
      expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    }
  );
  it('rejects ticket metadata on a stored receipt and retains raw-text restrictions', async () => {
    const invalid = { ...withWidth(58), type: 'RECEIPT' as const };
    expect(StoredPrintDocumentSchema.safeParse(invalid).success).toBe(false);
    db.restaurantPrintJob.findMany.mockResolvedValue([{ ...baseRow, document: invalid }]);
    expect(await claimNextPrintJob(scoped(), 'branch', 'bridge', now)).toBeNull();
    expect(() => renderEscPos({ ...withWidth(58), title: 'دکان' })).toThrow(
      'Unsupported printer text'
    );
  });
});
