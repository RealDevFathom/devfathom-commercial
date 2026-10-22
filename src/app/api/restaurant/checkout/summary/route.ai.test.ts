import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  route: null as null | {
    capability: string;
    run: (ctx: TestContext, request: Request) => Promise<Response>;
  },
  settlement: vi.fn(),
  readAIConfig: vi.fn(),
  tier: vi.fn(() => 'standard' as const),
  audit: vi.fn(),
}));

type TestContext = {
  organizationId: string;
  device: { branchId: string };
  session: { activeStaffProfileId: string };
  db: {
    organization: { findUnique: ReturnType<typeof vi.fn> };
  };
};

vi.mock('@/lib/restaurant/checkout-routes', () => ({
  getOrderSettlementForBranch: mocks.settlement,
  moneyReadRoute: (configuration: NonNullable<typeof mocks.route>) => {
    mocks.route = configuration;
    return configuration;
  },
}));
vi.mock('@/lib/ai/provider', () => ({ readAIConfig: mocks.readAIConfig }));
vi.mock('@/lib/ai/tiers', () => ({ getTierForFeature: mocks.tier }));
vi.mock('@/server/audit', () => ({ recordAudit: mocks.audit }));

const { setUpsellEngineForTest } = await import('./route');

const summary = {
  orderId: 'order-1',
  settled: false,
  blocker: 'ITEMS_UNBILLED',
  derivedOrderTotal: '2400.00',
  accountedTotal: '0.00',
  deliveryFeeTotal: '0.00',
  unbilledItemIds: ['line-1'],
  bills: [],
};

function context(
  options: { organizationId?: string; enabled?: boolean; storedOrgId?: string | null } = {}
) {
  const organizationId = options.organizationId ?? 'org-a';
  return {
    organizationId,
    device: { branchId: 'branch-a' },
    session: { activeStaffProfileId: 'staff-a' },
    db: {
      organization: {
        findUnique: vi.fn().mockResolvedValue(
          options.storedOrgId === null
            ? null
            : {
                id: options.storedOrgId ?? organizationId,
                askFathomEnabled: options.enabled ?? true,
              }
        ),
      },
    },
  } satisfies TestContext;
}

async function run(ctx: TestContext, orderId = 'order-1') {
  return mocks.route!.run(
    ctx,
    new Request(`https://example.test/api/restaurant/checkout/summary?orderId=${orderId}`)
  );
}

describe('checkout summary DevFathom AI contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settlement.mockResolvedValue(summary);
    mocks.readAIConfig.mockReturnValue({ provider: 'anthropic', model: 'fixture-model' });
    mocks.audit.mockResolvedValue(undefined);
    setUpsellEngineForTest({ suggest: vi.fn().mockResolvedValue({
      suggestion: null,
      model: 'fixture-model',
      tier: 'standard',
    }) });
  });

  it('stays behind the central money capability gate so an effective DENY is enforced there', () => {
    expect(mocks.route).toMatchObject({ capability: 'payments:collect' });
  });

  it('returns a tenant-scoped suggestion and writes its AI audit entry on the happy path', async () => {
    const suggest = vi.fn().mockResolvedValue({
      suggestion: {
        menuItemId: 'item-dessert',
        name: 'Chocolate cake',
        reason: 'Pairs with this order.',
      },
      model: 'fixture-model',
      tier: 'standard',
    });
    setUpsellEngineForTest({ suggest });
    const ctx = context();

    const response = await run(ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      orderId: 'order-1',
      aiUpsell: { menuItemId: 'item-dessert', name: 'Chocolate cake' },
    });
    expect(mocks.settlement).toHaveBeenCalledWith(ctx.db, 'order-1', 'branch-a');
    expect(ctx.db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-a' },
      select: { id: true, askFathomEnabled: true },
    });
    expect(suggest).toHaveBeenCalledWith({
      organizationId: 'org-a',
      branchId: 'branch-a',
      orderId: 'order-1',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        actorStaffProfileId: 'staff-a',
        category: 'AI',
        operation: 'READ',
        action: 'ai.restaurant.checkout-upsell',
        targetId: 'order-1',
        metadata: { model: 'fixture-model', tier: 'standard' },
      }),
      ctx.db
    );
  });

  it('does not cross tenant boundaries when the scoped organization lookup has no matching row', async () => {
    const suggest = vi.fn();
    setUpsellEngineForTest({ suggest });
    const ctx = context({ organizationId: 'org-b', storedOrgId: null });

    await expect((await run(ctx, 'order-from-org-a')).json()).resolves.toMatchObject({
      aiUpsell: null,
    });
    expect(mocks.settlement).toHaveBeenCalledWith(ctx.db, 'order-from-org-a', 'branch-a');
    expect(ctx.db.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-b' } })
    );
    expect(suggest).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'organization opt-in is absent', ctx: context({ enabled: false }), providerMissing: false },
    { label: 'provider secret is absent', ctx: context(), providerMissing: true },
  ])('keeps AI off by default when $label', async ({ ctx, providerMissing }) => {
    if (providerMissing) {
      mocks.readAIConfig.mockImplementation(() => {
        throw new Error('missing');
      });
    }
    const suggest = vi.fn();
    setUpsellEngineForTest({ suggest });

    await expect((await run(ctx)).json()).resolves.toMatchObject({ aiUpsell: null });
    expect(suggest).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not create an audit entry when the engine has no suggestion', async () => {
    const suggest = vi.fn().mockResolvedValue({
      suggestion: null,
      model: 'fixture-model',
      tier: 'standard',
    });
    setUpsellEngineForTest({ suggest });

    await expect((await run(context())).json()).resolves.toMatchObject({ aiUpsell: null });
    expect(suggest).toHaveBeenCalledOnce();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
