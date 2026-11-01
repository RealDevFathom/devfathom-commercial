import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn() }));

import { isUnknownTenantHost, unknownTenantVertical } from './unknown-tenant-host';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;
const ORIGINAL_SHARED_HOSTS = process.env.SHARED_APP_HOSTS;

beforeEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = 'pharmacy.example.com';
  delete process.env.SHARED_APP_HOSTS;
});

afterEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  if (ORIGINAL_SHARED_HOSTS === undefined) delete process.env.SHARED_APP_HOSTS;
  else process.env.SHARED_APP_HOSTS = ORIGINAL_SHARED_HOSTS;
});

const organization = { id: 'org-1', slug: 'sehatcart' } as never;

describe('isUnknownTenantHost', () => {
  it('flags a tenant subdomain that resolves to no organization', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const unknown = await isUnknownTenantHost('ehatcart.pharmacy.example.com', resolve);
    expect(unknown).toBe(true);
    expect(resolve).toHaveBeenCalledWith('ehatcart.pharmacy.example.com');
  });

  it('does not flag a tenant subdomain that resolves', async () => {
    const resolve = vi.fn().mockResolvedValue(organization);
    const unknown = await isUnknownTenantHost('sehatcart.pharmacy.example.com', resolve);
    expect(unknown).toBe(false);
  });

  it('never looks up shared, platform or empty hosts', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    for (const host of [
      'pharmacy.example.com',
      'www.pharmacy.example.com',
      'admin.pharmacy.example.com',
      '',
      null,
    ]) {
      await expect(isUnknownTenantHost(host, resolve)).resolves.toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('flags an unknown local development slug', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    await expect(isUnknownTenantHost('typo.localhost:3000', resolve)).resolves.toBe(true);
  });
});

describe('unknownTenantVertical', () => {
  it('reads a presentation hint from the host labels', () => {
    expect(unknownTenantVertical('ehatcart.pharmacy.example.com')).toBe('pharmacy');
    expect(unknownTenantVertical('x.restaurant.example.com:443')).toBe('restaurant');
    expect(unknownTenantVertical('x.hotel.example.com')).toBe('hotel');
    expect(unknownTenantVertical('x.example.com')).toBe('default');
    expect(unknownTenantVertical(null)).toBe('default');
  });
});
