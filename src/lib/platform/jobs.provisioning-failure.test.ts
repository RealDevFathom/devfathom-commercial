import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  jobUpdate: vi.fn(),
  jobFindUnique: vi.fn(),
  organizationFindUnique: vi.fn(),
  deploymentUpsert: vi.fn(),
  deploymentUpdateMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const platformDb = {
  $queryRaw: mocks.queryRaw,
  platformJob: {
    update: mocks.jobUpdate,
    findUnique: mocks.jobFindUnique,
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  organization: { findUnique: mocks.organizationFindUnique },
  organizationDeployment: {
    upsert: mocks.deploymentUpsert,
    updateMany: mocks.deploymentUpdateMany,
  },
};

import { processPlatformJobs } from './jobs';

function queuedProvisionJob(maxAttempts: number) {
  return {
    id: 'job_1',
    organizationId: 'org_1',
    type: 'PROVISION_SHARED',
    status: 'RUNNING',
    payload: {},
    result: null,
    error: null,
    attempts: 1,
    maxAttempts,
    idempotencyKey: null,
    requestedById: null,
    scheduledAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
}

describe('provisioning job failure state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ id: 'job_1' }]);
    mocks.jobFindUnique.mockResolvedValue({ status: 'RUNNING' });
    mocks.organizationFindUnique.mockResolvedValue({ slug: 'acme' });
    mocks.deploymentUpsert.mockRejectedValue(new Error('provisioning failed'));
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('marks the production deployment failed when provisioning exhausts its attempts', async () => {
    mocks.jobUpdate.mockResolvedValueOnce(queuedProvisionJob(1)).mockResolvedValueOnce({});

    await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 1, retried: 0 });
    expect(mocks.jobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job_1' },
      data: expect.objectContaining({ status: 'FAILED', error: 'provisioning failed' }),
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        environment: 'production',
        status: { not: 'DECOMMISSIONED' },
      },
      data: { status: 'FAILED' },
    });
  });

  it('keeps the deployment state unchanged while provisioning will retry', async () => {
    mocks.jobUpdate.mockResolvedValueOnce(queuedProvisionJob(3)).mockResolvedValueOnce({});

    await expect(processPlatformJobs(1)).resolves.toMatchObject({ failed: 0, retried: 1 });
    expect(mocks.jobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job_1' },
      data: expect.objectContaining({ status: 'QUEUED', error: 'provisioning failed' }),
    });
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
  });
});
