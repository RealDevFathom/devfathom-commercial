// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { retirePrinterInventory, printerRegistrationSchema } from './printer-inventory';
const request = { branchId: 'branch', printerId: 'printer' };
const stamp = new Date('2026-10-14T12:00:00Z');
function fixture() {
  const events: string[] = [];
  const state = {
    isolation: 'read committed' as string | null,
    active: true,
    missingBranch: false,
    missingPrinter: false,
    count: 1,
    error: null as Error | null,
    printer: {
      id: 'printer',
      organizationId: 'org',
      branchId: 'branch',
      bridgeId: 'revoked-bridge',
      name: 'Kitchen',
      retiredAt: null as Date | null,
      address: 'tcp://kitchen:9100',
      paperWidthMm: 58,
      status: 'OFFLINE',
      lastSeenAt: stamp,
      lastError: 'retained',
    },
    routes: [] as { id: string; enabled: boolean }[],
    jobs: [] as { id: string; status: string; attemptCount: number }[],
  };
  const untouched = vi.fn();
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('?');
      if (text.includes('transaction_isolation')) {
        events.push('isolation');
        expect(values).toEqual([]);
        return state.isolation === null ? [] : [{ isolation: state.isolation }];
      }
      expect(text).toContain('FOR UPDATE');
      expect(text).toContain("current_setting('app.current_organization_id', true)");
      if (text.includes('restaurant_branches')) {
        events.push('branch');
        expect(values).toEqual(['branch']);
        return state.missingBranch ? [] : [{ id: 'branch', active: state.active }];
      }
      expect(text).toContain('restaurant_printers');
      expect(values).toEqual(['printer', 'branch']);
      events.push('printer');
      return state.missingPrinter ? [] : [state.printer];
    }),
    restaurantPrintRoute: {
      findFirst: vi.fn(async ({ where }: { where: unknown }) => {
        events.push('routes');
        expect(where).toEqual({
          organizationId: 'org',
          branchId: 'branch',
          registeredPrinterId: 'printer',
        });
        return state.routes[0] ?? null;
      }),
      deleteMany: untouched,
      updateMany: untouched,
    },
    restaurantPrintJob: {
      findFirst: vi.fn(async ({ where }: { where: { status: { not: string } } }) => {
        events.push('jobs');
        expect(where).toEqual({
          organizationId: 'org',
          branchId: 'branch',
          registeredPrinterId: 'printer',
          status: { not: 'PRINTED' },
        });
        return state.jobs.find((j) => j.status !== where.status.not) ?? null;
      }),
      deleteMany: untouched,
      updateMany: untouched,
    },
    restaurantRegisteredDevice: { findFirst: untouched, updateMany: untouched },
    restaurantPrinter: {
      updateMany: vi.fn(async ({ where, data }: { where: unknown; data: { retiredAt: Date } }) => {
        events.push('retire');
        expect(where).toEqual({
          id: 'printer',
          organizationId: 'org',
          branchId: 'branch',
          retiredAt: null,
        });
        expect(Object.keys(data)).toEqual(['retiredAt']);
        if (state.error) throw state.error;
        if (state.count === 1) state.printer.retiredAt = data.retiredAt;
        return { count: state.count };
      }),
    },
  };
  const transaction = vi.fn(
    async (run: (value: typeof tx) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'ReadCommitted' });
      return run(tx);
    }
  );
  const db = { $transaction: transaction } as unknown as ScopedDb;
  return { state, tx, db, events, transaction, untouched };
}
afterEach(() => vi.useRealTimers());
it('retires once using ordered locks and only lifecycle data, even with a revoked bridge', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(stamp);
  const f = fixture();
  const before = structuredClone(f.state.printer);
  f.state.jobs = [{ id: 'printed', status: 'PRINTED', attemptCount: 1 }];
  const history = structuredClone(f.state.jobs);
  await expect(retirePrinterInventory(f.db, request)).resolves.toEqual({
    printer: { id: 'printer', branchId: 'branch', name: 'Kitchen', retiredAt: stamp },
    changed: true,
    bridgeId: 'revoked-bridge',
  });
  expect(f.events).toEqual(['isolation', 'branch', 'printer', 'routes', 'jobs', 'retire']);
  expect(f.state.printer).toEqual({ ...before, retiredAt: stamp });
  expect(f.state.jobs).toEqual(history);
  expect(f.untouched).not.toHaveBeenCalled();
});
it.each(['repeatable read', 'serializable', null, 'unexpected'])(
  'rejects actual isolation %s before all locks and writes',
  async (isolation) => {
    const f = fixture();
    f.state.isolation = isolation;
    await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.events).toEqual(['isolation']);
    expect(f.tx.restaurantPrinter.updateMany).not.toHaveBeenCalled();
  }
);
it.each(['missing', 'inactive'])('rejects %s branch before printer read', async (kind) => {
  const f = fixture();
  f.state.missingBranch = kind === 'missing';
  f.state.active = kind !== 'inactive';
  await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.events).toEqual(['isolation', 'branch']);
});
it('fails closed when tenant/branch/id scoped printer query finds nothing', async () => {
  const f = fixture();
  f.state.missingPrinter = true;
  await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.events).toEqual(['isolation', 'branch', 'printer']);
});
it.each([true, false])(
  'blocks an enabled=%s registered route without changing it',
  async (enabled) => {
    const f = fixture();
    f.state.routes = [{ id: 'route', enabled }];
    const before = structuredClone(f.state);
    await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state).toEqual(before);
    expect(f.tx.restaurantPrintJob.findFirst).not.toHaveBeenCalled();
    expect(f.untouched).not.toHaveBeenCalled();
  }
);
it.each([
  ['PENDING', 0],
  ['PENDING', 1],
  ['OFFLINE', 0],
  ['OFFLINE', 2],
  ['NO_PRINTER', 0],
])('blocks unfinished %s job with %s attempts', async (status, attemptCount) => {
  const f = fixture();
  f.state.jobs = [{ id: 'job', status: String(status), attemptCount: Number(attemptCount) }];
  const before = structuredClone(f.state);
  await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.state).toEqual(before);
  expect(f.tx.restaurantPrinter.updateMany).not.toHaveBeenCalled();
  expect(f.untouched).not.toHaveBeenCalled();
});
it('returns the original retirement timestamp before checking anomalous references', async () => {
  const f = fixture();
  f.state.printer.retiredAt = stamp;
  f.state.routes = [{ id: 'anomaly', enabled: false }];
  f.state.jobs = [{ id: 'anomaly', status: 'PENDING', attemptCount: 1 }];
  await expect(retirePrinterInventory(f.db, request)).resolves.toMatchObject({
    changed: false,
    printer: { retiredAt: stamp },
  });
  expect(f.events).toEqual(['isolation', 'branch', 'printer']);
  expect(f.tx.restaurantPrinter.updateMany).not.toHaveBeenCalled();
});
it('rejects a failed conditional update', async () => {
  const f = fixture();
  f.state.count = 0;
  await expect(retirePrinterInventory(f.db, request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.state.printer.retiredAt).toBeNull();
});
it('propagates database failures without fallback or success result', async () => {
  const f = fixture();
  const error = new Error('database failure');
  f.state.error = error;
  await expect(retirePrinterInventory(f.db, request)).rejects.toBe(error);
  expect(f.tx.restaurantPrinter.updateMany).toHaveBeenCalledOnce();
});
it.each(['organizationId', 'retiredAt', 'restore', 'status', 'address', 'paperWidthMm'])(
  'rejects caller-controlled %s before opening a transaction',
  async (key) => {
    const f = fixture();
    expect(() => retirePrinterInventory(f.db, { ...request, [key]: 'forged' })).toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  }
);
it('does not allow registration to set retirement state', () => {
  expect(() =>
    printerRegistrationSchema.parse({
      name: 'Kitchen',
      address: 'tcp://kitchen:9100',
      paperWidthMm: 58,
      retiredAt: stamp,
    })
  ).toThrow();
});
