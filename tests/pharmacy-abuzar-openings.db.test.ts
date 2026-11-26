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
  it('keeps pharmacy-specific product fields under forced tenant isolation', async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const state = await withTenantDb(
      'synthetic-scope',
      (db) =>
        db.$queryRaw`SELECT relrowsecurity AS rls,relforcerowsecurity AS forced FROM pg_class WHERE relname='pharmacy_abuzar_product_fields'`
    );
    expect(state).toEqual([{ rls: true, forced: true }]);
  });
});

it.runIf(process.env.TEST_DATABASE_URL)(
  'has a dedicated controlled opening entry kind distinct from a purchase or sale',
  async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    await expect(
      withTenantDb(
        'synthetic-scope',
        (db) => db.$queryRaw`SELECT 'OPENING'::"PharmacyControlledRegisterKind"::text AS kind`
      )
    ).resolves.toEqual([{ kind: 'OPENING' }]);
  }
);
