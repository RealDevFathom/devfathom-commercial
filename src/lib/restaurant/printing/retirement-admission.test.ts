// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PrintJob, PrintRoute } from './contract';
import { PrintBridgeService, claimNextPrintJob, acknowledgePrintJob } from './service';
import { replacePrintRoutesInTransaction } from './registered-routing';
const now = new Date('2026-10-14T12:00:00Z');
const route: PrintRoute = {
  documentType: 'RECEIPT',
  stationId: null,
  printerId: 'tcp://shared:9100',
  registeredPrinterId: 'retired',
  enabled: true,
};
const job: PrintJob = {
  branchId: 'branch',
  stationId: null,
  idempotencyKey: 'intent',
  document: {
    type: 'RECEIPT',
    reference: 'R-1',
    title: 'Receipt',
    createdAt: now.toISOString(),
    lines: [{ quantity: 1, label: 'Lunch' }],
  },
};
const pending = {
  id: 'job',
  organizationId: 'org',
  branchId: 'branch',
  registeredPrinterId: 'retired',
  printerId: route.printerId,
  status: 'PENDING',
  attemptCount: 0,
  lastAttemptAt: null as Date | null,
  document: job.document,
  documentType: 'RECEIPT',
};
function fixture() {
  const state = { retired: true, prior: null as unknown };
  const tx = {
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) =>
      sql.join('').includes('restaurant_printers')
        ? [{ id: values.at(-1) }]
        : [{ id: 'branch', active: true }]
    ),
    restaurantPrinter: {
      findFirst: vi.fn(async ({ where }: { where: { retiredAt?: null; id?: string } }) =>
        where.retiredAt === null && state.retired && where.id === 'retired'
          ? null
          : { id: where.id, paperWidthMm: 58 }
      ),
      findMany: vi.fn(async ({ where }: { where: { retiredAt?: null } }) =>
        where.retiredAt === null && state.retired
          ? []
          : [{ id: 'retired', address: route.printerId }]
      ),
    },
    restaurantKitchenStation: { findMany: vi.fn(async () => []) },
    restaurantPrintRoute: {
      findMany: vi.fn(async () => [route]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    restaurantPrintJob: {
      findUnique: vi.fn(async () => state.prior),
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const enqueue = (guarded: boolean, target = route) =>
    new PrintBridgeService(tx as unknown as ScopedDb).enqueue(
      'org',
      { branchId: 'branch', routes: [target] },
      job,
      guarded
        ? { printerId: target.printerId, registeredPrinterId: target.registeredPrinterId ?? null }
        : undefined
    );
  return { tx, state, enqueue };
}
afterEach(() => vi.unstubAllEnvs());
it.each([false, true])('rejects new retired registered enqueue guarded=%s', async (guarded) => {
  const f = fixture();
  if (guarded) await expect(f.enqueue(true)).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
  else await expect(f.enqueue(false)).resolves.toMatchObject({ status: 'NO_PRINTER' });
  expect(f.tx.restaurantPrintJob.create).not.toHaveBeenCalled();
});
it('preserves stored replay ahead of retired eligibility', async () => {
  const f = fixture();
  f.state.prior = { ...pending, status: 'PRINTED', byteCount: 30 };
  await expect(f.enqueue(false)).resolves.toMatchObject({
    status: 'PRINTED',
    replayed: true,
    printerId: route.printerId,
  });
  expect(f.tx.restaurantPrinter.findFirst).not.toHaveBeenCalled();
  expect(f.tx.$queryRaw).not.toHaveBeenCalled();
});
it.each([null, 'other-active'])(
  'retirement of one record does not block shared-address target %s',
  async (registeredPrinterId) => {
    const f = fixture();
    await expect(f.enqueue(false, { ...route, registeredPrinterId })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(f.tx.restaurantPrintJob.create).toHaveBeenCalledOnce();
  }
);
it('rejects retired route admission before replacement deletes anything', async () => {
  const f = fixture();
  await expect(
    replacePrintRoutesInTransaction(f.tx as unknown as Prisma.TransactionClient, 'org', {
      branchId: 'branch',
      routes: [route],
    })
  ).rejects.toMatchObject({ code: 'INVALID_ROUTE' });
  expect(f.tx.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.restaurantPrintRoute.createMany).not.toHaveBeenCalled();
});
it('filters an anomalous retired queued job before claim or attempt increment', async () => {
  const f = fixture();
  f.tx.restaurantPrintJob.findMany.mockImplementation(async ({ where }) => {
    expect(where.OR[0]).toEqual({ registeredPrinterId: null });
    return where.OR[1].registeredPrinter.is.retiredAt === null ? [] : [pending];
  });
  await expect(
    claimNextPrintJob(f.tx as unknown as ScopedDb, 'branch', 'bridge', now)
  ).resolves.toBeNull();
  expect(f.tx.restaurantPrintJob.updateMany).not.toHaveBeenCalled();
});
it('rechecks retirement in claim CAS when it changes after candidate selection', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-retirement-claim-test');
  const f = fixture();
  f.tx.restaurantPrintJob.findMany.mockResolvedValue([pending]);
  f.tx.restaurantPrintJob.updateMany.mockImplementation(async (...args: unknown[]) => {
    const query = args[0] as {
      where: { OR: Array<{ registeredPrinter?: { is: { retiredAt?: null } } }> };
    };
    expect(query.where.OR[1].registeredPrinter?.is.retiredAt).toBeNull();
    return { count: 0 };
  });
  await expect(
    claimNextPrintJob(f.tx as unknown as ScopedDb, 'branch', 'bridge', now)
  ).resolves.toBeNull();
});
it('allows a valid pre-existing claim to ACK after retirement without weakening token or lease checks', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-retirement-claim-test');
  const f = fixture();
  f.state.retired = false;
  f.tx.restaurantPrintJob.findMany.mockResolvedValue([pending]);
  const claim = await claimNextPrintJob(f.tx as unknown as ScopedDb, 'branch', 'bridge', now);
  expect(claim).not.toBeNull();
  f.state.retired = true;
  f.tx.restaurantPrintJob.findFirst.mockImplementation(async ({ where }: { where: unknown }) => {
    expect(where).toEqual({ id: 'job', branchId: 'branch' });
    return { ...pending, attemptCount: 1, lastAttemptAt: now };
  });
  f.tx.restaurantPrintJob.updateMany.mockClear();
  const input = {
    branchId: 'branch',
    deviceId: 'bridge',
    jobId: 'job',
    claimToken: claim!.claimToken,
    status: 'PRINTED' as const,
    now: new Date(now.getTime() + 1000),
  };
  await expect(
    acknowledgePrintJob(f.tx as unknown as ScopedDb, { ...input, deviceId: 'wrong' })
  ).resolves.toEqual({ acknowledged: false, replayed: false });
  await expect(
    acknowledgePrintJob(f.tx as unknown as ScopedDb, { ...input, claimToken: '0'.repeat(64) })
  ).resolves.toEqual({ acknowledged: false, replayed: false });
  await expect(
    acknowledgePrintJob(f.tx as unknown as ScopedDb, {
      ...input,
      now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
  ).resolves.toEqual({ acknowledged: false, replayed: false });
  expect(f.tx.restaurantPrintJob.updateMany).not.toHaveBeenCalled();
  await expect(acknowledgePrintJob(f.tx as unknown as ScopedDb, input)).resolves.toEqual({
    acknowledged: true,
    replayed: false,
  });
  const query = f.tx.restaurantPrintJob.updateMany.mock.calls[0] as unknown[];
  expect(query[0]).toMatchObject({
    where: {
      id: 'job',
      branchId: 'branch',
      status: 'PENDING',
      attemptCount: 1,
      lastAttemptAt: now,
    },
  });
  expect(JSON.stringify(query)).not.toContain('retiredAt');
});
