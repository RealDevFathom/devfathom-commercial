import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isReservedHostLabel } from './host-routing';

/**
 * The other tenancy suites pick a base domain by hand, so none of them exercise the
 * values we actually ship. This one reads infra/*.bicepparam at test time and runs
 * classifyHost against them: change a host in a param file without changing the
 * deployment's routing story and this fails.
 */

type DeployedHosts = {
  tenantHost: string;
  platformHost: string;
  baseDomain: string;
};

function readDeployedHosts(paramFile: string): DeployedHosts {
  const source = readFileSync(join(process.cwd(), 'infra', paramFile), 'utf8');
  const read = (name: string) => {
    const match = source.match(new RegExp(`^param ${name} = '([^']*)'$`, 'm'));
    if (!match) throw new Error(`infra/${paramFile} does not set a literal ${name}.`);
    return match[1];
  };
  return {
    tenantHost: read('tenantHost'),
    platformHost: read('platformHost'),
    baseDomain: read('baseDomain'),
  };
}

const ENVIRONMENTS = [
  { name: 'production', hosts: readDeployedHosts('production.bicepparam') },
  { name: 'staging', hosts: readDeployedHosts('staging.bicepparam') },
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

/** Mirror the container environment infra/environment.bicep builds from these parameters. */
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

  it('serves the canonical app host as a shared host no organization can claim', async () => {
    applyDeployedEnvironment(hosts);
    const { classifyHost } = await import('./host-routing');

    const classification = classifyHost(hosts.tenantHost);
    expect(classification.kind).toBe('tenant');
    // The app host may sit directly on the base domain (staging) or carry a label of its
    // own (production's www). Either way it must never resolve to a claimable slug.
    const slug = 'slug' in classification ? classification.slug : undefined;
    if (slug !== undefined) expect(isReservedHostLabel(slug)).toBe(true);
  });
});
