import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));

import { recordAIUsage } from './spend';

it('writes usage inside the attributed tenant scope', async () => {
  mocks.withTenantDb.mockImplementation(async (_organizationId, run) =>
    run({ aIUsage: { create: mocks.create } })
  );
  const usage = {
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    provider: 'google',
    model: 'gemini-test',
    inputTokens: 12,
    outputTokens: 7,
  };

  await recordAIUsage(usage);

  expect(mocks.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
    skipDrain: true,
  });
  expect(mocks.create).toHaveBeenCalledWith({ data: usage });
});
