import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import Join from './page';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'pharmacy.localhost:3111' }),
}));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<typeof import('@/lib/tenancy/host')>()),
  resolveOrganizationForRequest: vi.fn(),
}));
vi.mock('./sign-in-form', () => ({ PortalSignInForm: () => <button>Send me a code</button> }));

it('explains a failed tenant lookup without printing its private error', async () => {
  const { resolveOrganizationForRequest } = await import('@/lib/tenancy/host');
  vi.mocked(resolveOrganizationForRequest).mockRejectedValueOnce(
    new Error('private database details')
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const html = renderToStaticMarkup(
      await Join({ params: Promise.resolve({ token: 'pcl_' + '0'.repeat(26) }) })
    );
    expect(html).toContain('Something went wrong on our side. Please try again.');
    expect(log.mock.calls).toEqual([
      ['pharmacy.portal', { reason: 'UNEXPECTED', reference: expect.any(String) }],
    ]);
  } finally {
    log.mockRestore();
  }
});
