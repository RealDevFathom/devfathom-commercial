// @vitest-environment node
/**
 * DEV-167 regression: an activity insert made through `withTenantDb` must
 * finish before the interactive transaction closes. Prisma rejects a query that
 * is still pending when its transaction ends with P2028, and `logActivity`
 * swallows that rejection, so the activity entry is silently lost.
 *
 * The mocked `$transaction` reproduces that lifecycle: the transaction closes
 * as soon as its callback settles, and an insert that completes afterwards is
 * rejected with P2028 instead of being written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  create: vi.fn(),
  drainOrganization: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }));
vi.mock('@/lib/side-effects/drain', () => ({ drainOrganization: mocks.drainOrganization }));

import { trackTransactionWork } from '@/lib/side-effects/scope';
import { logActivity } from '@/server/activity';

import { withTenantDb } from './scoped-db';

type Deferred = { promise: Promise<void>; release: () => void };

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every queued microtask and timer callback run. */
async function settleEventLoop() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

let events: string[];
let writes: Array<() => void>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  events = [];
  writes = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.drainOrganization.mockResolvedValue(undefined);

  mocks.create.mockImplementation((args: { data: { type: string } }) => {
    const write = deferred();
    writes.push(write.release);
    return write.promise.then(() => {
      if (events.includes('transaction:closed')) {
        throw Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
      }
      events.push(`activity:${args.data.type}`);
      return { id: `activity-${events.length}` };
    });
  });

  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      activity: { create: mocks.create },
    };
    try {
      return await callback(tx);
    } finally {
      events.push('transaction:closed');
    }
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('activity writes inside withTenantDb (DEV-167)', () => {
  it('keeps the transaction open until a pending activity insert finishes', async () => {
    const result = withTenantDb('org_activity', async (tx) => {
      logActivity(tx, 'user-1', { type: 'project_created', message: 'created project Alpha' });
      return 'committed';
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await settleEventLoop();
    expect(events).toEqual([]);

    writes[0]();
    await expect(result).resolves.toBe('committed');

    expect(events).toEqual(['activity:project_created', 'transaction:closed']);
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.drainOrganization).not.toHaveBeenCalled();
  });

  it('waits for an activity logged while earlier transaction work is finishing', async () => {
    const earlier = deferred();

    const result = withTenantDb('org_activity', async (tx) => {
      trackTransactionWork(
        earlier.promise.then(() =>
          logActivity(tx, 'user-1', { type: 'task_completed', message: 'completed task Beta' })
        )
      );
      return 'committed';
    });

    await settleEventLoop();
    earlier.release();

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await settleEventLoop();
    expect(events).toEqual([]);

    writes[0]();
    await expect(result).resolves.toBe('committed');

    expect(events).toEqual(['activity:task_completed', 'transaction:closed']);
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.drainOrganization).not.toHaveBeenCalled();
  });

  it('settles a pending activity insert before rolling back a failed callback', async () => {
    const result = withTenantDb('org_activity', async (tx) => {
      logActivity(tx, 'user-1', { type: 'client_created', message: 'created client Gamma' });
      throw new Error('rolled back');
    });
    const outcome = result.catch((error: unknown) => error);

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await settleEventLoop();
    expect(events).toEqual([]);

    writes[0]();
    await expect(outcome).resolves.toEqual(new Error('rolled back'));

    expect(events).toEqual(['activity:client_created', 'transaction:closed']);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
