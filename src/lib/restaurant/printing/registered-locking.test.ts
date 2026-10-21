// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import type { PrintJob, PrintRoute } from './contract';
import { PrintBridgeService } from './service';
import { replacePrintRoutesInTransaction } from './registered-routing';

const target: PrintRoute = {
  documentType: 'KITCHEN_TICKET',
  stationId: null,
  printerId: 'tcp://kitchen:9100',
  registeredPrinterId: 'printer',
  enabled: true,
};
const job: PrintJob = {
  branchId: 'branch',
  stationId: null,
  idempotencyKey: 'intent',
  document: {
    type: 'KITCHEN_TICKET',
    reference: 'K-1',
    title: 'Kitchen',
    createdAt: '2026-10-14T12:00:00Z',
    lines: [{ quantity: 1, label: 'Lunch' }],
  },
};
function setup() {
  const events: string[] = [];
  const state: {
    branch: boolean;
    missingPrinter: boolean;
    lockError: Error | null;
    prior: unknown;
  } = {
    branch: true,
    missingPrinter: false,
    lockError: null,
    prior: null,
  };
  const db = {
    $executeRawUnsafe: vi.fn(async () => {
      events.push('idempotency');
    }),
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('?');
      if (text.includes('restaurant_branches')) {
        events.push('branch');
        expect(text).toMatch(/FOR (SHARE|UPDATE)/);
        expect(values).toEqual(['org', 'branch']);
        return state.branch ? [{ id: 'branch', active: true }] : [];
      }
      expect(text).toContain('restaurant_printers');
      expect(text).toContain('FOR SHARE');
      expect(values.slice(0, 2)).toEqual(['org', 'branch']);
      events.push('printer:' + values[2]);
      if (state.lockError) throw state.lockError;
      return state.missingPrinter ? [] : [{ id: values[2] }];
    }),
    restaurantPrinter: {
      findFirst: vi.fn(async () => {
        events.push('eligibility');
        return { id: 'printer', paperWidthMm: 58 };
      }),
      findMany: vi.fn(async () => {
        events.push('inventory');
        return ['a', 'z'].map((id) => ({ id, address: target.printerId }));
      }),
    },
    restaurantKitchenStation: { findMany: vi.fn(async () => []) },
    restaurantPrintRoute: {
      findMany: vi.fn(async () => {
        events.push('routes');
        return [target];
      }),
      deleteMany: vi.fn(async () => {
        events.push('delete');
      }),
      createMany: vi.fn(async () => {
        events.push('routes-create');
      }),
    },
    restaurantPrintJob: {
      findUnique: vi.fn(async () => {
        events.push('prior');
        return state.prior;
      }),
      create: vi.fn(async () => {
        events.push('job-create');
      }),
    },
  };
  const enqueue = (guarded: boolean, routes: PrintRoute[] = [target], input = job) =>
    new PrintBridgeService(db as unknown as ScopedDb).enqueue(
      'org',
      { branchId: 'branch', routes },
      input,
      guarded ? { printerId: target.printerId, registeredPrinterId: 'printer' } : undefined
    );
  return { db, state, events, enqueue };
}

describe('registered admission locks', () => {
  it.each([false, true])(
    'holds ordered locks before one width observation, guarded=%s',
    async (guarded) => {
      const { db, events, enqueue } = setup();
      await expect(enqueue(guarded)).resolves.toMatchObject({ status: 'QUEUED', replayed: false });
      expect(events).toEqual([
        'idempotency',
        'prior',
        'branch',
        ...(guarded ? ['routes'] : []),
        'printer:printer',
        'eligibility',
        'job-create',
      ]);
      expect(db.restaurantPrinter.findFirst).toHaveBeenCalledOnce();
      expect(db.restaurantPrintJob.create).toHaveBeenCalledOnce();
    }
  );
  it.each([false, true])('fails closed on a missing branch, guarded=%s', async (guarded) => {
    const { db, state, events, enqueue } = setup();
    state.branch = false;
    if (guarded) await expect(enqueue(true)).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
    else
      await expect(enqueue(false)).resolves.toMatchObject({
        status: 'NO_PRINTER',
        retryable: true,
      });
    expect(events).toEqual(['idempotency', 'prior', 'branch']);
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'does not observe an unlocked missing printer, guarded=%s',
    async (guarded) => {
      const { db, state, enqueue } = setup();
      state.missingPrinter = true;
      if (guarded) await expect(enqueue(true)).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
      else await expect(enqueue(false)).resolves.toMatchObject({ status: 'NO_PRINTER' });
      expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
      expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    'propagates a stale-snapshot lock error without fallback, guarded=%s',
    async (guarded) => {
      const { db, state, enqueue } = setup();
      const error = Object.assign(new Error('serialization'), { code: '40001' });
      state.lockError = error;
      await expect(enqueue(guarded)).rejects.toBe(error);
      expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
      expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['PENDING', 'OFFLINE', 'PRINTED'])(
    'replays persisted %s before locks',
    async (status) => {
      const { db, state, events, enqueue } = setup();
      state.prior = {
        status,
        registeredPrinterId: 'old-id',
        printerId: 'old-target',
        byteCount: 20,
      };
      await expect(enqueue(false)).resolves.toMatchObject({
        printerId: 'old-target',
        replayed: true,
      });
      expect(events).toEqual(['idempotency', 'prior']);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    }
  );
  it('preserves no-route early return even if a prior job exists', async () => {
    const { state, events, enqueue } = setup();
    state.prior = { status: 'PRINTED' };
    await expect(enqueue(false, [])).resolves.toMatchObject({
      status: 'NO_PRINTER',
      replayed: false,
    });
    expect(events).toEqual([]);
  });
  it('preserves the branch mismatch early return', async () => {
    const { events, enqueue } = setup();
    await expect(enqueue(false, [target], { ...job, branchId: 'other' })).resolves.toMatchObject({
      status: 'NO_PRINTER',
    });
    expect(events).toEqual([]);
  });
  it('does not add inventory or branch locks for a raw-only job', async () => {
    const { db, events, enqueue } = setup();
    await expect(enqueue(false, [{ ...target, registeredPrinterId: null }])).resolves.toMatchObject(
      { status: 'QUEUED' }
    );
    expect(events).toEqual(['idempotency', 'prior', 'job-create']);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('refuses a registered caller without row-lock access', async () => {
    const { db } = setup();
    const { $queryRaw: omitted, ...withoutLocks } = db;
    void omitted;
    await expect(
      new PrintBridgeService(withoutLocks as unknown as ScopedDb).enqueue(
        'org',
        { branchId: 'branch', routes: [target] },
        job
      )
    ).rejects.toThrow('row locking');
    expect(db.restaurantPrinter.findFirst).not.toHaveBeenCalled();
    expect(db.restaurantPrintJob.create).not.toHaveBeenCalled();
  });
});

describe('route replacement printer locks', () => {
  const routes = ['z', 'a', 'z'].map((registeredPrinterId, i) => ({
    ...target,
    registeredPrinterId,
    documentType: ['RECEIPT', 'KITCHEN_TICKET', 'BAR_TICKET'][i] as PrintRoute['documentType'],
  }));
  const replace = (db: ReturnType<typeof setup>['db']) =>
    replacePrintRoutesInTransaction(db as unknown as Prisma.TransactionClient, 'org', {
      branchId: 'branch',
      routes,
    });
  it('locks unique IDs sequentially in sorted order before validation and replacement', async () => {
    const { db, events } = setup();
    await replace(db);
    expect(events).toEqual([
      'branch',
      'routes',
      'printer:a',
      'printer:z',
      'inventory',
      'delete',
      'routes-create',
    ]);
    expect(db.restaurantPrintRoute.createMany).toHaveBeenCalledWith({
      data: routes.map((r) => ({ ...r, organizationId: 'org', branchId: 'branch' })),
    });
  });
  it('preserves existing routes if a printer disappears before its lock', async () => {
    const { db, state } = setup();
    state.missingPrinter = true;
    await expect(replace(db)).rejects.toMatchObject({ code: 'INVALID_ROUTE' });
    expect(db.restaurantPrinter.findMany).not.toHaveBeenCalled();
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('propagates lock failures without replacement or unlocked fallback', async () => {
    const { db, state } = setup();
    const error = new Error('stale snapshot');
    state.lockError = error;
    await expect(replace(db)).rejects.toBe(error);
    expect(db.restaurantPrinter.findMany).not.toHaveBeenCalled();
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
});
