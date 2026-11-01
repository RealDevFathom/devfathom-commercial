import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const download = vi.hoisted(() => vi.fn());
const resolveTenantActor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor }));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({ session: { user: { id: 'owner-1' } } })),
}));
vi.mock('@/server/routers/_app', () => ({
  appRouter: {
    // The namespaced caller keeps the `pharmacyDataExport.download` procedure
    // path, so the shared module middleware applies the Pharmacy Core check.
    createCaller: () => ({ pharmacyDataExport: { download } }),
  },
}));

import { GET, POST } from './route';

function post(body: unknown, origin: string | null = 'https://pharmacy.example') {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: 'pharmacy.example',
    'x-forwarded-proto': 'https',
  };
  if (origin) headers.origin = origin;
  return new Request('https://pharmacy.example/api/pharmacy/data-export', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  download.mockReset();
  resolveTenantActor.mockReset();
  resolveTenantActor.mockResolvedValue({
    session: { user: { id: 'owner-1' } },
    organization: { id: 'org-a' },
    support: null,
  });
});

describe('/api/pharmacy/data-export', () => {
  it('no longer serves an archive from a GET link, so the PIN never sits in a URL', async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(download).not.toHaveBeenCalled();
  });

  it('streams the archive for a same-origin POST carrying the PIN', async () => {
    download.mockResolvedValue({
      fileName: 'devfathom-pharmacy-export-2026-10-31-exp-1.zip',
      data: Buffer.from('PK-archive'),
      sha256: 'a'.repeat(64),
    });
    const response = await POST(post({ id: 'exp-1', pin: '2468' }));
    expect(response.status).toBe(200);
    expect(download).toHaveBeenCalledExactlyOnceWith({ id: 'exp-1', pin: '2468' });
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="devfathom-pharmacy-export-2026-10-31-exp-1.zip"'
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('PK-archive');
  });

  it.each([
    ['a cross-site origin', 'https://attacker.example'],
    ['no origin', null],
  ])('refuses %s before reading the session or the archive', async (_label, origin) => {
    const response = await POST(post({ id: 'exp-1', pin: '2468' }, origin));
    expect(response.status).toBe(403);
    expect(resolveTenantActor).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses a body without a PIN', async () => {
    const response = await POST(post({ id: 'exp-1' }));
    expect(response.status).toBe(400);
    expect(download).not.toHaveBeenCalled();
  });

  it('maps a wrong PIN, a lost entitlement and a locked PIN to their HTTP statuses', async () => {
    download.mockRejectedValueOnce(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'That PIN is not correct.' })
    );
    const wrong = await POST(post({ id: 'exp-1', pin: '0000' }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe('That PIN is not correct.');

    download.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'The Pharmacy Core module is not enabled.' })
    );
    expect((await POST(post({ id: 'exp-1', pin: '2468' }))).status).toBe(403);

    download.mockRejectedValueOnce(new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Locked.' }));
    expect((await POST(post({ id: 'exp-1', pin: '2468' }))).status).toBe(429);
  });

  it('refuses an anonymous request', async () => {
    resolveTenantActor.mockResolvedValue(null);
    const response = await POST(post({ id: 'exp-1', pin: '2468' }));
    expect(response.status).toBe(401);
    expect(download).not.toHaveBeenCalled();
  });
});
