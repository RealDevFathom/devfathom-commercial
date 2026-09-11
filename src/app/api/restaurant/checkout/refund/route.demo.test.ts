import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOptions: null as null | { run: (ctx: unknown) => Promise<Response> },
  resolveDemoApproverIdentity: vi.fn(),
  operatorHasCapability: vi.fn(),
}));

vi.mock('@/lib/restaurant/checkout-routes', () => ({
  moneyReadRoute: (options: typeof mocks.readOptions) => {
    mocks.readOptions = options;
    return vi.fn();
  },
  moneyMutationRoute: () => vi.fn(),
  refundBody: {},
  resolveApprover: vi.fn(),
  resolveDemoApproverIdentity: mocks.resolveDemoApproverIdentity,
  operatorHasCapability: mocks.operatorHasCapability,
  serializeRefundResult: vi.fn(),
}));
vi.mock('@/lib/restaurant/refunds', () => ({ refundTender: vi.fn() }));

await import('./route');

function context() {
  return {
    db: { restaurantTender: { findMany: vi.fn().mockResolvedValue([]) } },
    device: { branchId: 'branch_demo' },
  };
}

describe('refund GET demo approval metadata', () => {
  beforeEach(() => {
    mocks.resolveDemoApproverIdentity.mockReset();
    mocks.operatorHasCapability.mockReset();
  });

  it('returns the capability-checked public designated approver without a secret', async () => {
    const candidate = {
      staffProfileId: 'staff_demo_approver',
      displayName: 'Demo Approver',
      expiresAt: Date.now() + 60_000,
    };
    mocks.resolveDemoApproverIdentity.mockResolvedValue(candidate);
    mocks.operatorHasCapability.mockResolvedValue(true);

    const response = await mocks.readOptions!.run(context());
    const body = await response.json();

    expect(body).toEqual({ demoApproval: candidate, tenders: [] });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      expect.anything(),
      candidate.staffProfileId,
      'coauth:approve',
      expect.any(Date)
    );
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('omits demo approval for an ordinary actor or an approver without capability', async () => {
    for (const candidate of [null, { staffProfileId: 'staff_no_capability' }]) {
      mocks.resolveDemoApproverIdentity.mockResolvedValueOnce(candidate);
      mocks.operatorHasCapability.mockResolvedValueOnce(false);

      const response = await mocks.readOptions!.run(context());
      await expect(response.json()).resolves.toEqual({ tenders: [] });
    }
    expect(mocks.operatorHasCapability).toHaveBeenCalledTimes(1);
  });
});
