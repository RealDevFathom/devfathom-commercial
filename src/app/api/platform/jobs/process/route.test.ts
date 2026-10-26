import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processPlatformJobs: vi.fn(),
  processDueOwnerDigests: vi.fn(),
  processDueResignationOffboarding: vi.fn(),
}));

vi.mock('@/lib/platform/jobs', () => ({ processPlatformJobs: mocks.processPlatformJobs }));
vi.mock('@/lib/pharmacy/owner-digest', () => ({
  processDueOwnerDigests: mocks.processDueOwnerDigests,
}));
vi.mock('@/lib/resignation-offboarding', () => ({
  processDueResignationOffboarding: mocks.processDueResignationOffboarding,
}));

import { POST } from './route';

describe('platform job processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CRON_SECRET', 'test-secret');
    mocks.processPlatformJobs.mockResolvedValue({ processed: 2 });
    mocks.processDueOwnerDigests.mockResolvedValue({ sent: 1 });
    mocks.processDueResignationOffboarding.mockResolvedValue({ offboarded: 1 });
  });

  it('runs resignation offboarding as part of an authenticated cron request', async () => {
    const response = await POST(
      new Request('http://localhost/api/platform/jobs/process', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ maxJobs: 10 }),
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.processPlatformJobs).toHaveBeenCalledWith(10);
    expect(mocks.processDueOwnerDigests).toHaveBeenCalledWith(expect.any(Date), 10);
    expect(mocks.processDueResignationOffboarding).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      processed: 2,
      ownerDigests: { sent: 1 },
      resignationOffboarding: { offboarded: 1 },
    });
  });
});
