// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
describe.runIf(process.env.TEST_DATABASE_URL)('Abuzar opening row references', () => {
  it('persists an immutable tenant-scoped source key for each opening document row', async () => {
    assertDisposableRlsDatabase(process.env.TEST_DATABASE_URL!);
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const state = await withTenantDb(
      'synthetic-scope',
      (db) =>
        db.$queryRaw`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname='pharmacy_abuzar_openings'`
    );
    expect(state).toEqual([{ rls: true, forced: true }]);
  });
});
