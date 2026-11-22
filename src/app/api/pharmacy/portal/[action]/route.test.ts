import { expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../../../tests/fixtures/bounded-request';

const handle = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pharmacy/customer-portal-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-portal-http')>()),
  portalContext: async () => ({ handle }),
}));

import { POST } from './route';

it('rejects a chunked overflow before dispatching even a body-independent action', async () => {
  const { request, cancelled, bytesRead } = oversizedRequest(7_500_000);
  expect((await POST(request, { params: Promise.resolve({ action: 'sign-out' }) })).status).toBe(
    413
  );
  expect(cancelled()).toBe(true);
  expect(bytesRead()).toBeLessThanOrEqual(7_500_000 + 16_384);
  expect(handle).not.toHaveBeenCalled();
});
