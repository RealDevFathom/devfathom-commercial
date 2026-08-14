/**
 * The deployment lookup inside `resolveExplicitOrganizationByHost`, against a
 * REAL PostgreSQL.
 *
 * A mock cannot establish any of what this file is for. The three properties
 * under test are all decided by the database:
 *
 *   - the match is EXACT, not a substring. The old lookup was
 *     `url contains host`, so the host `app` matched a deployment recorded at
 *     `https://acme.apps.example.test` and handed an anonymous caller a tenant it
 *     never named.
 *   - the match is CASE-INSENSITIVE. Prisma compiles `equals` + `mode:
 *     'insensitive'` to `ILIKE`, and whether `ILIKE` actually ignores case is a
 *     PostgreSQL fact, not a Prisma one.
 *   - two organizations claiming one host resolve to NOTHING. Whether both rows
 *     come back at all depends on the real query.
 *
 * A seeded READY deployment is load-bearing. Against an empty table every
 * "resolves to no organization" assertion here passes for the wrong reason, and
 * would keep passing if the fix were reverted.
 *
 * Requires TEST_DATABASE_URL (a migrated, seeded, throwaway database — the same
 * variable `test:rls` and `token-single-use.test.ts` use, and never
 * DATABASE_URL). Without it the suite reports itself skipped rather than passing
 * vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39). The three
 * properties above — exact match rather than substring, case insensitivity, and
 * two organizations resolving to nothing — are decided by the query, not by row
 * level security, and `resolveExplicitOrganizationByHost` runs inside
 * `withPlatformDb` anyway. Bypassing row level security WIDENS visibility,
 * which makes the `resolves.toBeNull()` assertions harder to satisfy, not
 * easier: a privileged role could only push this file toward failing, never
 * toward passing vacuously.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The client in `@/lib/db` reads DATABASE_URL when its module is evaluated, so
// this must happen before the dynamic imports below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (prefix: string) => `${prefix}_pr19_${suffix}`;

const TENANT_HOST = 'acme.apps.example.test';
const TENANT_URL = `https://${TENANT_HOST}`;

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  resolveExplicitOrganizationByHost: (typeof import('@/lib/tenancy/host'))['resolveExplicitOrganizationByHost'];
  resolveOrganizationByHost: (typeof import('@/lib/tenancy/host'))['resolveOrganizationByHost'];
};

let deps: Deps;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

/** Create an organization plus its production deployment at `url`. */
async function seedTenant(key: string, slug: string, url: string) {
  await deps.withPlatformDb(async (db) => {
    await db.organization.create({
      data: {
        id: id(key),
        slug,
        legalName: `${slug} Ltd`,
        displayName: slug,
        status: 'ACTIVE',
      },
    });
    await db.organizationDeployment.create({
      data: {
        id: id(`deploy_${key}`),
        organizationId: id(key),
        environment: 'production',
        mode: 'SHARED',
        status: 'READY',
        url,
      },
    });
  });
}

describeIfDatabase(
  'resolveExplicitOrganizationByHost, deployment lookup against PostgreSQL',
  () => {
    beforeAll(async () => {
      // Pin host classification so the assertions do not depend on whatever the
      // developer's .env.local happens to say.
      vi.stubEnv('PLATFORM_BASE_DOMAIN', 'devfathom.com');
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.devfathom.com');
      vi.stubEnv('AUTH_URL', 'https://staging.devfathom.com');
      vi.stubEnv('VERCEL_URL', '');

      deps = {
        withPlatformDb: (await import('@/lib/tenancy/scoped-db')).withPlatformDb,
        ...(await import('@/lib/tenancy/host')),
      };

      await seedTenant('org_acme', `pr19-acme-${suffix}`, TENANT_URL);
    }, 60_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      if (!deps?.withPlatformDb) return;
      await deps.withPlatformDb(async (db) => {
        await db.organizationDeployment.deleteMany({
          where: { id: { in: [id('deploy_org_acme'), id('deploy_org_rival')] } },
        });
        await db.organization.deleteMany({
          where: { id: { in: [id('org_acme'), id('org_rival')] } },
        });
      });
    }, 60_000);

    it('resolves the seeded organization from its exact host', async () => {
      const organization = await deps.resolveExplicitOrganizationByHost(TENANT_HOST);

      expect(organization?.id).toBe(id('org_acme'));
    });

    /**
     * The substring regression, stated as a host. `app` is a substring of
     * `acme.apps.example.test`, so the old `url contains host` lookup resolved this
     * to the seeded tenant. It must now name nothing.
     */
    it('does not resolve a host that is merely a substring of a deployment URL', async () => {
      await expect(deps.resolveExplicitOrganizationByHost('app')).resolves.toBeNull();
    });

    it('resolves a lowercase request host against an UPPERCASE stored URL', async () => {
      await deps.withPlatformDb((db) =>
        db.organizationDeployment.update({
          where: { id: id('deploy_org_acme') },
          data: { url: TENANT_URL.toUpperCase() },
        })
      );

      try {
        const organization = await deps.resolveExplicitOrganizationByHost(TENANT_HOST);
        expect(organization?.id).toBe(id('org_acme'));
      } finally {
        await deps.withPlatformDb((db) =>
          db.organizationDeployment.update({
            where: { id: id('deploy_org_acme') },
            data: { url: TENANT_URL },
          })
        );
      }
    });

    /**
     * The outage itself. `staging.devfathom.com` is a shared host: it names no
     * tenant, and the strict resolver must say so rather than fall through to a
     * default organization or to whichever deployment happens to match.
     */
    it('resolves nothing for the shared staging host', async () => {
      await expect(
        deps.resolveExplicitOrganizationByHost('staging.devfathom.com')
      ).resolves.toBeNull();
    });

    describe('when two organizations claim the same host', () => {
      beforeAll(async () => {
        // Same host, different case — so this is only ambiguous BECAUSE the match
        // is case-insensitive. A case-sensitive lookup would miss the collision
        // entirely and hand the caller one of the two tenants.
        await seedTenant('org_rival', `pr19-rival-${suffix}`, `https://ACME.apps.EXAMPLE.test`);
      }, 60_000);

      afterAll(async () => {
        await deps.withPlatformDb(async (db) => {
          await db.organizationDeployment.deleteMany({ where: { id: id('deploy_org_rival') } });
          await db.organization.deleteMany({ where: { id: id('org_rival') } });
        });
      }, 60_000);

      it('fails closed and names no organization at all', async () => {
        const warn = vi.fn();

        await expect(
          deps.resolveExplicitOrganizationByHost(TENANT_HOST, { warn })
        ).resolves.toBeNull();
      });

      it('emits a structured ambiguity warning carrying both organizations', async () => {
        const warn = vi.fn();

        await deps.resolveExplicitOrganizationByHost(TENANT_HOST, { warn });

        expect(warn).toHaveBeenCalledTimes(1);
        const warning = warn.mock.calls[0][0];

        expect(warning).toMatchObject({
          event: 'tenant_host_resolution_ambiguous',
          hostname: TENANT_HOST,
          matchCount: 2,
          organizationCount: 2,
        });
        expect(warning.organizationIds).toEqual(
          expect.arrayContaining([id('org_acme'), id('org_rival')])
        );
        expect(warning.deploymentIds).toEqual(
          expect.arrayContaining([id('deploy_org_acme'), id('deploy_org_rival')])
        );

        // The resolver runs on unauthenticated traffic, so the warning must carry
        // nothing that identifies the caller.
        const serialized = JSON.stringify(warning);
        expect(serialized).not.toMatch(/@/);
        expect(serialized).not.toMatch(/token/i);
        expect(serialized).not.toMatch(/cookie|authorization|user-agent/i);
      });

      /**
       * PR C and PR D depend on the permissive resolver staying exactly as it is,
       * so the fail-closed behaviour must be confined to the strict sibling.
       */
      it('leaves resolveOrganizationByHost unchanged', async () => {
        const organization = await deps.resolveOrganizationByHost(TENANT_HOST);

        expect(organization).not.toBeNull();
      });
    });
  }
);
