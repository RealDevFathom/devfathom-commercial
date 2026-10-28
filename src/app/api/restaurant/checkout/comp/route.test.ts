import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalContext } from '@/lib/restaurant/terminal-auth';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  withTerminalAuth: (handler: unknown) => handler,
  authenticateOperator: vi.fn(async () => ({ ok: true, staffProfileId: 'manager' })),
}));
vi.mock('@/lib/restaurant/bills', async (original) => ({
  ...(await original<typeof import('@/lib/restaurant/bills')>()),
  compLine: vi.fn(async () => ({ replayed: false })),
}));
import { GET, POST } from './route';
import { compLine } from '@/lib/restaurant/bills';
import { authenticateOperator } from '@/lib/restaurant/terminal-auth';

function context(capabilities: string[], denied: string[] = []) {
  return {
    organizationId: 'session-org',
    state: 'UNLOCKED',
    session: { activeStaffProfileId: 'actor' },
    device: { id: 'device', branchId: 'branch' },
    db: {
      restaurantStaffProfile: {
        findUnique: vi.fn(async () => ({
          status: 'ACTIVE',
          primaryBranchId: 'branch',
          user: null,
        })),
      },
      restaurantStaffJobRole: {
        findMany: vi.fn(async ({ where }: { where: { staffProfileId: string } }) => [
          {
            jobRole: {
              capabilities: (where.staffProfileId === 'manager'
                ? ['coauth:approve']
                : capabilities
              ).map((capability) => ({ capability })),
            },
          },
        ]),
      },
      restaurantStaffCapabilityGrant: {
        findMany: vi.fn(async () => denied.map((capability) => ({ capability, effect: 'DENY' }))),
      },
      restaurantBill: { findFirst: vi.fn(async () => ({ id: 'bill' })) },
      restaurantOrder: { findFirst: vi.fn(async () => ({ id: 'order' })) },
      restaurantBillLine: { findMany: vi.fn(async () => []) },
    },
  } as unknown as TerminalContext;
}
const body = {
  billId: 'bill',
  billLineId: 'line',
  reason: 'Hospitality',
  approving: { staffProfileId: 'manager', type: 'PIN', secret: '1234' },
};
const post = POST as unknown as (ctx: TerminalContext, request: Request) => Promise<Response>;
const get = GET as unknown as typeof post;
function mutation() {
  return new Request('http://localhost/api/restaurant/checkout/comp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'comp-key' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => vi.clearAllMocks());
describe('comp capability boundary (#275)', () => {
  it('allows complimentary without payments:collect and retains manager approval', async () => {
    expect((await post(context(['orders:complimentary']), mutation())).status).toBe(200);
    expect(authenticateOperator).toHaveBeenCalled();
    expect(compLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvingStaffProfileId: 'manager',
        actor: expect.objectContaining({ staffProfileId: 'actor' }),
      })
    );
  });
  it.each([['payments:collect'], []])(
    'denies missing complimentary grant: %j',
    async (...grants) => {
      const ctx = context(grants.flat());
      expect((await post(ctx, mutation())).status).toBe(403);
      expect(compLine).not.toHaveBeenCalled();
      expect(authenticateOperator).not.toHaveBeenCalled();
    }
  );
  it.each(['orders:complimentary', 'orders:*', '*'])(
    'DENY %s wins over wildcard ALLOW',
    async (deny) => {
      expect((await post(context(['*'], [deny]), mutation())).status).toBe(403);
      expect(compLine).not.toHaveBeenCalled();
    }
  );
  it('reads only open lines in the authenticated branch for comp-only staff', async () => {
    const ctx = context(['orders:complimentary']);
    expect(
      (await get(ctx, new Request('http://localhost/api/restaurant/checkout/comp?orderId=order')))
        .status
    ).toBe(200);
    expect(ctx.db.restaurantBillLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { compAmount: 0, bill: { orderId: 'order', branchId: 'branch', status: 'OPEN' } },
      })
    );
  });
  it('denies line reads to payment-only staff', async () => {
    const ctx = context(['payments:collect']);
    expect(
      (await get(ctx, new Request('http://localhost/api/restaurant/checkout/comp?orderId=order')))
        .status
    ).toBe(403);
    expect(ctx.db.restaurantBillLine.findMany).not.toHaveBeenCalled();
  });
});
