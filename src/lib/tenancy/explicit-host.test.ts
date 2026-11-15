/**
 * `resolveExplicitOrganizationByHost` decides, for an anonymous and host-routed
 * action, which tenant the caller actually named. Getting it wrong means mailing
 * a password-reset link for an organization nobody asked about.
 *
 * The scenario driving these tests is staging as it is deployed today:
 * NEXT_PUBLIC_APP_URL, AUTH_URL, VERCEL_URL and PLATFORM_BASE_DOMAIN are ALL set
 * to `staging.devfathom.com`, so that host lands in `configuredDefaultHosts()`
 * and `resolveOrganizationByHost` maps it onto DEFAULT_ORGANIZATION_ID.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: vi.fn(),
  createTenantDb: vi.fn(),
}));

import { resolveExplicitOrganizationByHost, resolveOrganizationByHost } from '@/lib/tenancy/host';

const ORGANIZATION = {
  id: 'org_acme',
  slug: 'acme',
  displayName: 'Acme',
  legalName: 'Acme Inc',
  status: 'ACTIVE',
  deploymentMode: 'SHARED',
  timezone: 'UTC',
  locale: 'en',
  currency: 'USD',
  seatLimit: 10,
};

const DEFAULT_ORGANIZATION = { ...ORGANIZATION, id: 'org_devfathom', slug: 'devfathom' };

const ENV_KEYS = [
  'PLATFORM_BASE_DOMAIN',
  'NEXT_PUBLIC_APP_URL',
  'AUTH_URL',
  'VERCEL_URL',
  'DEFAULT_ORGANIZATION_ID',
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/**
 * A fake platform-scope client. Every lookup is recorded so a test can assert
 * that a shared host stopped BEFORE the deployment lookup, not merely that it
 * happened to return nothing.
 */
function fakeDb(rows: {
  organizationBySlug?: Record<string, typeof ORGANIZATION>;
  organizationById?: Record<string, typeof ORGANIZATION>;
  domain?: Record<string, { verificationStatus: string; organization: typeof ORGANIZATION }>;
  deployments?: Array<{
    url: string;
    provider?: string;
    organization: typeof ORGANIZATION;
  }>;
}) {
  const calls: string[] = [];
  const db = {
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug !== undefined) {
          calls.push(`slug:${where.slug}`);
          return rows.organizationBySlug?.[where.slug] ?? null;
        }
        calls.push(`id:${where.id}`);
        return rows.organizationById?.[where.id as string] ?? null;
      }),
    },
    organizationDomain: {
      findUnique: vi.fn(async ({ where }: { where: { host: string } }) => {
        calls.push(`domain:${where.host}`);
        return rows.domain?.[where.host] ?? null;
      }),
    },
    organizationDeployment: {
      // `resolveOrganizationByHost` — the permissive sibling — still matches by
      // substring, and this fake keeps behaving exactly as Prisma's `contains`
      // does so that half of the suite still tests what it used to.
      findFirst: vi.fn(async ({ where }: { where: { url: { contains: string } } }) => {
        calls.push(`deployment:${where.url.contains}`);
        const hit = rows.deployments?.find((d) => d.url.includes(where.url.contains));
        return hit ? { organization: hit.organization } : null;
      }),
      // `resolveExplicitOrganizationByHost` matches whole URLs, case-insensitively,
      // and inspects every match rather than taking the first.
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            OR: Array<{ url: { equals: string; mode: string } }>;
            provider?: string;
          };
        }) => {
          const wanted = new Set(where.OR.map((clause) => clause.url.equals.toLowerCase()));
          calls.push(`deployment:exact:${[...wanted][0]}`);
          return (rows.deployments ?? [])
            .filter(
              (deployment) =>
                wanted.has(deployment.url.toLowerCase()) &&
                (!where.provider || deployment.provider === where.provider)
            )
            .map((deployment, index) => ({
              id: `deploy_${index}`,
              url: deployment.url,
              provider: deployment.provider,
              organizationId: deployment.organization.id,
              organization: deployment.organization,
            }));
        }
      ),
    },
  };
  mocks.withPlatformDb.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run(db)
  );
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_BASE_DOMAIN = 'staging.devfathom.com';
  process.env.NEXT_PUBLIC_APP_URL = 'https://staging.devfathom.com';
  process.env.AUTH_URL = 'https://staging.devfathom.com';
  process.env.VERCEL_URL = 'staging.devfathom.com';
  process.env.DEFAULT_ORGANIZATION_ID = 'org_devfathom';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

describe('resolveExplicitOrganizationByHost', () => {
  it('resolves a tenant subdomain by its slug', async () => {
    fakeDb({ organizationBySlug: { acme: ORGANIZATION } });

    await expect(resolveExplicitOrganizationByHost('acme.staging.devfathom.com')).resolves.toEqual(
      ORGANIZATION
    );
  });

  it('resolves a verified custom domain', async () => {
    fakeDb({
      domain: {
        'portal.acme.com': { verificationStatus: 'VERIFIED', organization: ORGANIZATION },
      },
    });

    await expect(resolveExplicitOrganizationByHost('portal.acme.com')).resolves.toEqual(
      ORGANIZATION
    );
  });

  it('ignores a custom domain that is not verified', async () => {
    fakeDb({
      domain: {
        'portal.acme.com': { verificationStatus: 'PENDING', organization: ORGANIZATION },
      },
    });

    await expect(resolveExplicitOrganizationByHost('portal.acme.com')).resolves.toBeNull();
  });

  // The reason this function exists.
  it('returns null for the shared staging host instead of the default organization', async () => {
    fakeDb({ organizationById: { org_devfathom: DEFAULT_ORGANIZATION } });

    await expect(resolveExplicitOrganizationByHost('staging.devfathom.com')).resolves.toBeNull();
  });

  it.each(['localhost', '127.0.0.1', 'staging.devfathom.com'])(
    'never looks up DEFAULT_ORGANIZATION_ID for the shared host %s',
    async (host) => {
      const calls = fakeDb({ organizationById: { org_devfathom: DEFAULT_ORGANIZATION } });

      await expect(resolveExplicitOrganizationByHost(host)).resolves.toBeNull();
      expect(calls.some((call) => call.startsWith('id:'))).toBe(false);
    }
  );

  /**
   * A shared host must stop before the deployment lookup runs at all, not merely
   * come back empty from it. The lookup is exact now, so `staging.devfathom.com`
   * would no longer reach `acme-staging.devfathom.com` on its own — but the early
   * stop is what makes that independent of how the lookup is written, and it is
   * still what keeps the shared host from matching a deployment recorded at
   * exactly that host.
   */
  it('stops before the deployment lookup on a shared host', async () => {
    const calls = fakeDb({
      deployments: [{ url: 'https://acme-staging.devfathom.com', organization: ORGANIZATION }],
    });

    await expect(resolveExplicitOrganizationByHost('staging.devfathom.com')).resolves.toBeNull();
    expect(calls.some((call) => call.startsWith('deployment:'))).toBe(false);
  });

  it('returns null for a host nobody has registered', async () => {
    fakeDb({});

    await expect(resolveExplicitOrganizationByHost('who-is-this.example.com')).resolves.toBeNull();
  });

  it('treats AWS ECS as an opaque deployment provider', async () => {
    fakeDb({
      deployments: [
        {
          url: 'https://portal.acme.com',
          provider: 'AWS_ECS',
          organization: ORGANIZATION,
        },
      ],
    });

    await expect(resolveExplicitOrganizationByHost('portal.acme.com')).resolves.toEqual(
      ORGANIZATION
    );
  });

  it('returns null for the platform host', async () => {
    fakeDb({});

    await expect(
      resolveExplicitOrganizationByHost('admin.staging.devfathom.com')
    ).resolves.toBeNull();
  });

  // Development hosts land in configuredDefaultHosts() via NEXT_PUBLIC_APP_URL,
  // so the slug lookup has to run first or local reset requests would break.
  it('still resolves a <slug>.localhost development host by slug', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'localhost';
    process.env.NEXT_PUBLIC_APP_URL = 'http://acme.localhost:3000';
    process.env.AUTH_URL = 'http://acme.localhost:3000';
    delete process.env.VERCEL_URL;
    fakeDb({ organizationBySlug: { acme: ORGANIZATION } });

    await expect(resolveExplicitOrganizationByHost('acme.localhost:3000')).resolves.toEqual(
      ORGANIZATION
    );
  });
});

describe('resolveOrganizationByHost is deliberately unchanged', () => {
  // PR C and PR D depend on the signed-in resolver behaving exactly as it does
  // today, which is why the strict rule is a sibling rather than a flag.
  it('still falls back to the default organization on the shared staging host', async () => {
    fakeDb({ organizationById: { org_devfathom: DEFAULT_ORGANIZATION } });

    await expect(resolveOrganizationByHost('staging.devfathom.com')).resolves.toEqual(
      DEFAULT_ORGANIZATION
    );
  });

  it('still falls back to the default organization on localhost', async () => {
    fakeDb({ organizationById: { org_devfathom: DEFAULT_ORGANIZATION } });

    await expect(resolveOrganizationByHost('localhost')).resolves.toEqual(DEFAULT_ORGANIZATION);
  });
});
