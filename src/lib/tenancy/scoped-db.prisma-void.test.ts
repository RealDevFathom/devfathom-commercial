import { describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('scoped database context setup', () => {
  it('sets transaction-local tenant and platform context without deserializing void', async () => {
    const [{ db }, { withPlatformDb, withTenantDb }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/tenancy/scoped-db'),
    ]);
    const organizationId = 'org_scoped_db_void_regression';

    await expect(
      withTenantDb(
        organizationId,
        (tx) =>
          tx.$queryRaw<Array<{ organizationId: string; isPlatformAdmin: string }>>`
          SELECT current_setting('app.current_organization_id') AS "organizationId",
                 current_setting('app.is_platform_admin') AS "isPlatformAdmin"
        `
      )
    ).resolves.toEqual([{ organizationId, isPlatformAdmin: 'false' }]);

    await expect(
      withPlatformDb(
        (tx) =>
          tx.$queryRaw<Array<{ organizationId: string; isPlatformAdmin: string }>>`
          SELECT current_setting('app.current_organization_id') AS "organizationId",
                 current_setting('app.is_platform_admin') AS "isPlatformAdmin"
        `
      )
    ).resolves.toEqual([{ organizationId: '', isPlatformAdmin: 'true' }]);

    const [outside] = await db.$queryRaw<
      Array<{ organizationId: string | null; isPlatformAdmin: string | null }>
    >`
      SELECT current_setting('app.current_organization_id', true) AS "organizationId",
             current_setting('app.is_platform_admin', true) AS "isPlatformAdmin"
    `;
    expect(outside?.organizationId).not.toBe(organizationId);
    expect(outside?.isPlatformAdmin).not.toBe('true');
  });
});
