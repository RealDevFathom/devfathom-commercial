// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: vi.fn(),
  ownerDigests: vi.fn(),
  licenceRenewals: vi.fn(),
}));

vi.mock('@/lib/platform/jobs', () => ({ processPlatformJobs: mocks.jobs }));
vi.mock('@/lib/pharmacy/owner-digest', () => ({ processDueOwnerDigests: mocks.ownerDigests }));
vi.mock('@/lib/pharmacy/whatsapp/licence-renewal-reminders', () => ({
  processDueWhatsAppLicenceRenewalReminders: mocks.licenceRenewals,
}));

import { GET, POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'cron-test-secret');
  mocks.jobs.mockResolvedValue({ claimed: 1, succeeded: 1 });
  mocks.ownerDigests.mockResolvedValue({ due: 1, captured: 1 });
  mocks.licenceRenewals.mockResolvedValue({ configured: true, sent: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(method: string, authorization?: string, body?: unknown) {
  return new Request('https://www.devfathom.com/api/platform/jobs/process', {
    method,
    headers: authorization ? { authorization } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/platform/jobs/process', () => {
  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)(
    'runs licence renewal reminders alongside existing jobs on authenticated %s',
    async (method, handler) => {
      const response = await handler(request(method, 'Bearer cron-test-secret'));

      expect(response.status).toBe(200);
      expect(mocks.jobs).toHaveBeenCalledExactlyOnceWith(25);
      expect(mocks.ownerDigests).toHaveBeenCalledExactlyOnceWith(expect.any(Date), 25);
      expect(mocks.licenceRenewals).toHaveBeenCalledExactlyOnceWith();
      await expect(response.json()).resolves.toEqual({
        claimed: 1,
        succeeded: 1,
        ownerDigests: { due: 1, captured: 1 },
        licenceRenewals: { configured: true, sent: 1 },
      });
    }
  );

  it('preserves the requested limit for platform jobs and owner digests', async () => {
    await POST(request('POST', 'Bearer cron-test-secret', { maxJobs: 5 }));

    expect(mocks.jobs).toHaveBeenCalledWith(5);
    expect(mocks.ownerDigests).toHaveBeenCalledWith(expect.any(Date), 5);
    expect(mocks.licenceRenewals).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'Bearer wrong', 'Bearer cron-test-secreT'])(
    'does not run any worker without valid authorization (%s)',
    async (authorization) => {
      const response = await GET(request('GET', authorization));

      expect(response.status).toBe(401);
      expect(mocks.jobs).not.toHaveBeenCalled();
      expect(mocks.ownerDigests).not.toHaveBeenCalled();
      expect(mocks.licenceRenewals).not.toHaveBeenCalled();
    }
  );

  it('does not run any worker when the cron secret is missing', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const response = await GET(request('GET', 'Bearer cron-test-secret'));

    expect(response.status).toBe(401);
    expect(mocks.jobs).not.toHaveBeenCalled();
    expect(mocks.ownerDigests).not.toHaveBeenCalled();
    expect(mocks.licenceRenewals).not.toHaveBeenCalled();
  });
});
