import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { localWorkspaceAddresses } from '../prisma/seed-workspace-addresses';

function fixture() {
  const findMany = vi.fn().mockResolvedValue([
    { displayName: 'Agency', slug: 'devfathom' },
    { displayName: 'Local Pharmacy', slug: 'my-pharmacy' },
  ]);
  const tx = { organization: { findMany } } as unknown as Parameters<
    typeof localWorkspaceAddresses
  >[0];
  return { tx, findMany };
}

describe('local seed workspace addresses', () => {
  it('prints each workspace slug on its own hostname at the configured port', async () => {
    const { tx, findMany } = fixture();
    const lines = await localWorkspaceAddresses(tx, {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3100',
    });
    expect(lines).toContain('  Agency: http://devfathom.localhost:3100/login');
    expect(lines).toContain('  Local Pharmacy: http://my-pharmacy.localhost:3100/login');
    expect(lines).toContain('  Platform operator: http://admin.localhost:3100/platform/login');
    expect(lines.join('\n')).toContain('Plain localhost uses DEFAULT_ORGANIZATION_ID');
    expect(findMany).toHaveBeenCalledWith({
      select: { displayName: true, slug: true },
      orderBy: { slug: 'asc' },
    });
  });

  it.each([
    [{}, 'http://my-pharmacy.localhost:3000/login'],
    [{ AUTH_URL: 'http://devfathom.localhost:3100' }, 'http://my-pharmacy.localhost:3100/login'],
    [
      { NEXT_PUBLIC_APP_URL: 'http://localhost:3000', PORT: '3100' },
      'http://my-pharmacy.localhost:3100/login',
    ],
    [{ NEXT_PUBLIC_APP_URL: 'http://localhost' }, 'http://my-pharmacy.localhost/login'],
  ])('uses the local server port from %j', async (env, address) => {
    const { tx } = fixture();
    expect((await localWorkspaceAddresses(tx, env)).join('\n')).toContain(address);
  });

  it.each([
    'https://app.example.com',
    'http://localhost.example.com',
    'invalid',
    'ftp://localhost',
  ])('does not query or print tenant information for a nonlocal/invalid origin %s', async (url) => {
    const { tx, findMany } = fixture();
    expect(await localWorkspaceAddresses(tx, { NEXT_PUBLIC_APP_URL: url })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('collects addresses after the rerunnable tenant seed and prints only after commit', () => {
    const source = readFileSync('prisma/seed.ts', 'utf8');
    const collect = source.indexOf('return localWorkspaceAddresses(tx);');
    expect(collect).toBeGreaterThan(source.indexOf('await seedTenantData(tx);'));
    expect(source.indexOf('for (const line of addresses) console.log(line);')).toBeGreaterThan(
      source.indexOf('{ maxWait: 30_000, timeout: 300_000 }', collect)
    );
  });
});
