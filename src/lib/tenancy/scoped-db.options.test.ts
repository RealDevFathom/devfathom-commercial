// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  credentialTransaction: vi.fn(),
  scope: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: { $transaction: mocks.transaction },
  credentialAttemptDb: { $transaction: mocks.credentialTransaction },
}));
import { createTenantDb, withTenantDb, withTenantCredentialDb, withPlatformDb } from './scoped-db';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (run) =>
    run({ $queryRawUnsafe: mocks.scope, restaurantPrintRoute: { findMany: mocks.query } })
  );
  mocks.credentialTransaction.mockImplementation(async (run) =>
    run({ $queryRawUnsafe: mocks.scope, restaurantOperatorCredential: { findMany: mocks.query } })
  );
  mocks.query.mockResolvedValue([]);
});
describe('tenant transaction isolation options', () => {
  it('uses the reserved pool for credential attempts with tenant RLS and user scope', async () => {
    // The request pool cannot supply a connection while these attempts run.
    mocks.transaction.mockImplementation(() => {
      throw new Error('request pool exhausted');
    });
    await withTenantCredentialDb('org', (tx) => tx.restaurantOperatorCredential.findMany(), {
      userId: 'operator',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.credentialTransaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      maxWait: 10000,
      timeout: 30000,
    });
    expect(mocks.scope.mock.calls[0].slice(1)).toEqual(['org', 'operator']);
    expect(mocks.scope.mock.calls[0][0]).toContain(
      "set_config('app.is_platform_admin', 'false', true)"
    );
    expect(mocks.scope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[0]
    );
  });

  it('rejects an invalid credential tenant before acquiring a reserved connection', async () => {
    await expect(
      withTenantCredentialDb("bad'org", async () => true, { userId: 'operator' })
    ).rejects.toThrow('Invalid organization');
    expect(mocks.credentialTransaction).not.toHaveBeenCalled();
  });

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
});
