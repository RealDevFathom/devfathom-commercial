import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isReservedHostLabel } from './host-routing';

/**
 * The other tenancy suites pick a base domain by hand, so none of them exercise the
 * values we actually ship. This one reads the AWS environment template
 * (infra/aws/environment.yaml) at test time and runs classifyHost against its hosts:
 * change a host there without changing the deployment's routing story and this fails.
 * Production is not created on AWS yet; its stack takes these hosts as parameters.
 */

type DeployedHosts = {
  tenantHost: string;
  platformHost: string;
  baseDomain: string;
};

function readTemplateDefault(name: string): string {
  const source = readFileSync(join(process.cwd(), 'infra', 'aws', 'environment.yaml'), 'utf8');
  const parameter = source.match(new RegExp(`^  ${name}:\\n((?:    .*\\n)+)`, 'm'));
  const value = parameter?.[1].match(/^    Default: (\S+)$/m)?.[1];
  if (!value) throw new Error(`infra/aws/environment.yaml does not default ${name}.`);
  return value;
}

/** The web task gets PLATFORM_BASE_DOMAIN=BaseDomain; the console is admin.<BaseDomain>. */
function readStagingHosts(): DeployedHosts {
  const baseDomain = readTemplateDefault('BaseDomain');
  return {
    tenantHost: readTemplateDefault('TenantHost'),
    platformHost: `admin.${baseDomain}`,
    baseDomain,
  };
}

const ENVIRONMENTS = [
  {
    name: 'production',
    hosts: {
      tenantHost: 'www.devfathom.com',
      platformHost: 'admin.devfathom.com',
      baseDomain: 'devfathom.com',
    },
  },
  { name: 'staging', hosts: readStagingHosts() },
];

const ORIGINAL_ENV = {
  PLATFORM_BASE_DOMAIN: process.env.PLATFORM_BASE_DOMAIN,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  AUTH_URL: process.env.AUTH_URL,
  VERCEL_URL: process.env.VERCEL_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Mirror the web task environment infra/aws/environment.yaml builds from these parameters. */
function applyDeployedEnvironment({ tenantHost, baseDomain }: DeployedHosts) {
  process.env.AUTH_URL = `https://${tenantHost}`;
  process.env.NEXT_PUBLIC_APP_URL = `https://${tenantHost}`;
  process.env.PLATFORM_BASE_DOMAIN = baseDomain;
  delete process.env.VERCEL_URL;
}

describe.each(ENVIRONMENTS)('$name deployed host contract', ({ hosts }) => {
  it('derives the platform host from the base domain', () => {
    expect(hosts.platformHost).toBe(`admin.${hosts.baseDomain}`);
  });

  it('classifies the platform host as the control plane', async () => {
    applyDeployedEnvironment(hosts);
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost(hosts.platformHost)).toEqual({
      kind: 'platform',
      host: hosts.platformHost,
    });
  });

  it('resolves a tenant subdomain of the base domain to its slug', async () => {
    applyDeployedEnvironment(hosts);
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost(`acme.${hosts.baseDomain}`)).toEqual({
      kind: 'tenant',
      host: `acme.${hosts.baseDomain}`,
      slug: 'acme',
    });
  });

  /**
   * Deliberately accepts a classification this repository does not produce yet. `shared` is not
   * a HostKind today; Standard Shared-Host Login is expected to add it for exactly this host, and
   * pinning the assertion to 'tenant' would turn that desired change into a red test. What has to
   * hold either way is the routing invariant, not the label: the canonical app host is never the
   * control plane, never unroutable, and never a slug an organization could claim.
   */
  it('keeps the canonical app host off the control plane and out of claimable slugs', async () => {
    applyDeployedEnvironment(hosts);
    const { classifyHost } = await import('./host-routing');

    const classification = classifyHost(hosts.tenantHost);
    expect(['tenant', 'shared']).toContain(classification.kind);

    // Slug rules apply only to the tenant variant. A `shared` classification carries no slug by
    // construction — that absence is the correct shape, not a missing-slug case to explain.
    if (classification.kind === 'tenant') {
      const slug = 'slug' in classification ? classification.slug : undefined;
      if (slug === undefined) {
        // A tenant classification with no slug is only legitimate when the app is served on the
        // base domain itself, as staging is. Production's www must arrive as a reserved label.
        expect(hosts.tenantHost).toBe(hosts.baseDomain);
      } else {
        expect(isReservedHostLabel(slug)).toBe(true);
      }
    }
  });
});
