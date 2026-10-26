import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  findBrand: vi.fn(),
  loadRemoteImage: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn((_organizationId, work) =>
    work({ organizationBrand: { findUnique: mocks.findBrand } })
  ),
}));
vi.mock('@/lib/remote-image', () => ({ loadRemoteImage: mocks.loadRemoteImage }));

import { GET } from './route';

describe('GET /api/finance/issuer-logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue({
      session: { user: { id: 'admin-1' } },
      organization: { id: 'org-1' },
    });
    mocks.findBrand.mockResolvedValue({ logoUrl: 'https://assets.example/northstar.svg' });
    mocks.loadRemoteImage.mockResolvedValue({
      body: new TextEncoder().encode('<svg />'),
      contentType: 'image/svg+xml',
    });
  });

  it('delivers the authenticated tenant logo from the same-origin endpoint', async () => {
    const response = await GET(new Request('https://tenant.example/api/finance/issuer-logo'));

    expect(mocks.findBrand).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: { logoUrl: true },
    });
    expect(mocks.loadRemoteImage).toHaveBeenCalledWith(
      'https://assets.example/northstar.svg'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(await response.text()).toBe('<svg />');
  });

  it('does not expose a logo without an authenticated tenant', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    expect((await GET(new Request('https://tenant.example/api/finance/issuer-logo'))).status).toBe(
      401
    );
    expect(mocks.findBrand).not.toHaveBeenCalled();
  });

  it('fails closed when the configured remote logo cannot be safely loaded', async () => {
    mocks.loadRemoteImage.mockRejectedValue(new Error('private address'));

    const response = await GET(new Request('https://tenant.example/api/finance/issuer-logo'));

    expect(response.status).toBe(502);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
