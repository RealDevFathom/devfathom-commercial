import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/restaurant/administrator-staff-profile', () => ({
  ensureAdministratorStaffProfile: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) =>
    run({
      platformJob: { findUnique: mocks.findUnique, update: mocks.update },
      platformAuditLog: { create: mocks.auditCreate },
    })
  ),
}));

import { executePlatformCommand } from './commands';

const actor = { id: 'platform_admin_retrying', role: 'SUPER_ADMIN' } as never;
const request = new Request('http://localhost/api/platform/commands');

describe('job.retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'job_1',
      organizationId: 'org_1',
      type: 'PURGE_DATA',
      ...data,
    }));
  });

  it('records the retrying administrator on a job that named no requester', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'job_1',
      status: 'FAILED',
      type: 'PURGE_DATA',
      requestedById: null,
    });
    await executePlatformCommand(
      actor,
      'job.retry',
      { id: 'job_1', reason: 'Retrying an older purge job.' },
      request
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.requestedById).toBe('platform_admin_retrying');
    expect(data.status).toBe('QUEUED');
  });
});
