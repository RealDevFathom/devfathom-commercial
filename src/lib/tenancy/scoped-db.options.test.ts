// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), scope: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }));
import { trackTransactionWork } from '@/lib/side-effects/scope';
import { createTenantDb, withTenantDb, withPlatformDb } from './scoped-db';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (run) =>
    run({ $queryRawUnsafe: mocks.scope, restaurantPrintRoute: { findMany: mocks.query } })
  );
  mocks.query.mockResolvedValue([]);
});
describe('tenant transaction isolation options', () => {
  it('forwards explicit isolation while applying tenant and user scope before queries', async () => {
    await withTenantDb('org', (tx) => tx.restaurantPrintRoute.findMany(), {
      userId: 'operator',
      isolationLevel: 'ReadCommitted',
      maxWait: 12,
      timeout: 34,
    });
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      maxWait: 12,
      timeout: 34,
      isolationLevel: 'ReadCommitted',
    });
    expect(mocks.scope.mock.calls[0].slice(1)).toEqual(['org', 'operator']);
    expect(mocks.scope.mock.calls[0][0]).toContain(
      "set_config('app.is_platform_admin', 'false', true)"
    );
    expect(mocks.scope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[0]
    );
  });
  it('leaves omitted isolation to the existing database default', async () => {
    await withTenantDb('org', async () => true);
    expect(mocks.transaction.mock.calls[0][1]).toEqual({ maxWait: 10000, timeout: 30000 });
    expect(mocks.scope.mock.calls[0].slice(1)).toEqual(['org', '']);
  });
  it('forwards facade transaction options and retains its user scope', async () => {
    await createTenantDb('org', 'operator').$transaction(
      (tx) => tx.restaurantPrintRoute.findMany(),
      { isolationLevel: 'ReadCommitted' }
    );
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      maxWait: 10000,
      timeout: 30000,
      isolationLevel: 'ReadCommitted',
    });
    expect(mocks.scope.mock.calls[0].slice(1)).toEqual(['org', 'operator']);
  });
  it('keeps nested transactions on the outer connection and isolation', async () => {
    await withTenantDb(
      'org',
      (tx) =>
        tx.$transaction((inner) => inner.restaurantPrintRoute.findMany(), {
          isolationLevel: 'Serializable',
        }),
      { isolationLevel: 'ReadCommitted' }
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1].isolationLevel).toBe('ReadCommitted');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it('does not alter ordinary facade model calls or platform defaults', async () => {
    await createTenantDb('org').restaurantPrintRoute.findMany();
    await withPlatformDb(async () => true);
    expect(mocks.transaction.mock.calls.map((call) => call[1])).toEqual([
      { maxWait: 10000, timeout: 30000 },
      { maxWait: 10000, timeout: 30000 },
    ]);
    expect(mocks.scope.mock.calls[1][0]).toContain(
      "set_config('app.is_platform_admin', 'true', true)"
    );
  });
  it('rejects invalid tenant identity before opening a transaction', async () => {
    await expect(
      withTenantDb("bad'org", async () => true, { isolationLevel: 'ReadCommitted' })
    ).rejects.toThrow('Invalid organization');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('settles transaction-local work before rethrowing a callback failure', async () => {
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    let markCallbackStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      markCallbackStarted = resolve;
    });
    let rejected = false;

    const result = withTenantDb('org', async () => {
      trackTransactionWork(work);
      markCallbackStarted();
      throw new Error('rolled back');
    }).catch((error: unknown) => {
      rejected = true;
      throw error;
    });

    await callbackStarted;
    await Promise.resolve();
    expect(rejected).toBe(false);

    finishWork();
    await expect(result).rejects.toThrow('rolled back');
  });
});
