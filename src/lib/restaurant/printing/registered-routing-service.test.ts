// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PrintJob, PrintRoute } from './contract';
import { acknowledgePrintJob, claimNextPrintJob, PrintBridgeService } from './service';

const now = new Date('2026-10-14T03:00:00Z');
const job: PrintJob = { branchId: 'branch', stationId: null, idempotencyKey: 'print-intent', document: { type: 'RECEIPT', reference: 'R-1', title: 'Receipt', createdAt: now.toISOString(), lines: [{ quantity: 1, label: 'Lunch' }] } };
const route: PrintRoute = { documentType: 'RECEIPT', stationId: null, printerId: 'tcp://raw-target:9100', registeredPrinterId: 'inventory-id', enabled: true };
const candidate = { id: 'job', organizationId: 'org', branchId: 'branch', registeredPrinterId: 'inventory-id', printerId: route.printerId, status: 'PENDING', attemptCount: 0, lastAttemptAt: null, document: job.document, documentType: 'RECEIPT' };
function makeDb() {
  return {
    $executeRawUnsafe: vi.fn(),
    restaurantPrinter: { findFirst: vi.fn().mockResolvedValue({ id: 'inventory-id' }) },
    restaurantPrintJob: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([candidate]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findFirst: vi.fn() },
  };
}
let db: ReturnType<typeof makeDb>;
const scoped = () => db as unknown as ScopedDb;
beforeEach(() => { db = makeDb(); vi.stubEnv('AUTH_SECRET', 'unit-test-claim-key'); });
afterEach(() => vi.unstubAllEnvs());
describe('registered job snapshots and synchronous delivery', () => {
  it('stores registry reference and raw target for new jobs', async () => {
    await new PrintBridgeService(scoped()).enqueue('org', { branchId: 'branch', routes: [route] }, job);
    expect(db.restaurantPrintJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ registeredPrinterId: 'inventory-id', printerId: route.printerId }) });
  });
  it('retains legacy snapshots with a null reference and no inventory lookup', async () => {
    await new PrintBridgeService(scoped()).enqueue('org', { branchId: 'branch', routes: [{ ...route, registeredPrinterId: undefined }] }, job);
    expect(db.restaurantPrintJob.create.mock.calls[0][0].data.registeredPrinterId).toBeNull();
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
  });
  it('does not persist an unavailable registered destination', async () => {
    db.restaurantPrinter.findFirst.mockResolvedValue(null);
    await expect(new PrintBridgeService(scoped()).enqueue('org', { branchId: 'branch', routes: [route] }, job)).resolves.toMatchObject({ status: 'NO_PRINTER' });
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'OFFLINE', 'PRINTED'])('retains the exact prior %s snapshot during an enqueue replay', async (status) => {
    db.restaurantPrintJob.findUnique.mockResolvedValue({ ...candidate, status, byteCount: 12 });
    await expect(new PrintBridgeService(scoped()).enqueue('org', { branchId: 'branch', routes: [{ ...route, registeredPrinterId: 'new-id', printerId: 'new-address' }] }, job)).resolves.toMatchObject({ printerId: route.printerId, replayed: true });
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.update).not.toHaveBeenCalled();
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'OFFLINE', 'PRINTED'])('refuses a prior registered %s job under a current legacy route before delivery or replay', async (status) => {
    db.restaurantPrintJob.findUnique.mockResolvedValue({ ...candidate, status, byteCount: 12 });
    const send = vi.fn();
    await expect(new PrintBridgeService({ kind: 'test', send }, scoped()).submit('org', { branchId: 'branch', routes: [{ ...route, registeredPrinterId: null }] }, job)).rejects.toThrow('authenticated bridge');
    expect(send).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.update).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(db.restaurantPrintJob.findUnique.mock.invocationCallOrder[0]);
  });
  it.each([null, { ...candidate, registeredPrinterId: null }])('refuses current registered routing before creating or sending', async (prior) => {
    db.restaurantPrintJob.findUnique.mockResolvedValue(prior);
    const send = vi.fn();
    await expect(new PrintBridgeService({ kind: 'test', send }, scoped()).submit('org', { branchId: 'branch', routes: [route] }, job)).rejects.toThrow('authenticated bridge');
    expect(send).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
});
describe('registered bridge claims', () => {
  it('filters by owner before the ten-job limit and pins claim CAS to the same target', async () => {
    // Selection-aware stand-in: ten older jobs belong to another bridge.
    db.restaurantPrintJob.findMany.mockImplementation(async ({ where, take }) => {
      expect(take).toBe(10);
      expect(where).toMatchObject({ branchId: 'branch', printerId: { not: null }, status: 'PENDING', attemptCount: 0, lastAttemptAt: null });
      expect(where.OR).toEqual([{ registeredPrinterId: null }, { registeredPrinter: { is: { branchId: 'branch', bridgeId: 'bridge', branch: { is: { active: true } }, bridge: { is: { id: 'bridge', branchId: 'branch', kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null } } } } }]);
      return [candidate];
    });
    const result = await claimNextPrintJob(scoped(), 'branch', 'bridge', now);
    expect(result).toMatchObject({ id: 'job', printerId: route.printerId, claimToken: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result).not.toHaveProperty('registeredPrinterId');
    expect(db.restaurantPrintJob.updateMany.mock.calls[0][0].where).toEqual({ id: 'job', branchId: 'branch', registeredPrinterId: 'inventory-id', printerId: route.printerId, OR: db.restaurantPrintJob.findMany.mock.calls[0][0].where.OR, status: 'PENDING', attemptCount: 0, lastAttemptAt: null });
  });
  it('returns no bytes when ownership changes before the claim CAS', async () => {
    db.restaurantPrintJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await claimNextPrintJob(scoped(), 'branch', 'bridge', now)).toBeNull();
  });
  it('applies identical ownership and snapshot conditions to invalid-document holds', async () => {
    db.restaurantPrintJob.findMany.mockResolvedValue([{ ...candidate, document: { ...job.document, title: '\u001bINVALID' } }]);
    expect(await claimNextPrintJob(scoped(), 'branch', 'bridge', now)).toBeNull();
    expect(db.restaurantPrintJob.updateMany.mock.calls[0][0]).toMatchObject({ where: { registeredPrinterId: 'inventory-id', printerId: route.printerId, OR: db.restaurantPrintJob.findMany.mock.calls[0][0].where.OR, attemptCount: 0, lastAttemptAt: null }, data: { status: 'OFFLINE' } });
  });
  it('preserves device-bound HMAC, lease rejection and completed replay acknowledgement', async () => {
    const claimed = await claimNextPrintJob(scoped(), 'branch', 'bridge', now);
    db.restaurantPrintJob.findFirst.mockResolvedValue({ ...candidate, attemptCount: 1, lastAttemptAt: now });
    const input = { branchId: 'branch', deviceId: 'bridge', jobId: 'job', claimToken: claimed!.claimToken, status: 'PRINTED' as const, now: new Date(now.getTime() + 1000) };
    expect(await acknowledgePrintJob(scoped(), { ...input, deviceId: 'other' })).toEqual({ acknowledged: false, replayed: false });
    expect(await acknowledgePrintJob(scoped(), { ...input, now: new Date(now.getTime() + 30000) })).toEqual({ acknowledged: false, replayed: false });
    expect(await acknowledgePrintJob(scoped(), input)).toEqual({ acknowledged: true, replayed: false });
    db.restaurantPrintJob.findFirst.mockResolvedValue({ ...candidate, status: 'PRINTED', attemptCount: 1, lastAttemptAt: now });
    expect(await acknowledgePrintJob(scoped(), input)).toEqual({ acknowledged: true, replayed: true });
  });
});
