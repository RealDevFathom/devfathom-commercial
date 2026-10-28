import { expect, it, vi } from 'vitest';
import type { TerminalContext } from './terminal-auth';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

vi.mock('server-only', () => ({}));
vi.mock('./terminal-auth', () => ({ withTerminalAuth: (handler: unknown) => handler }));
import { requireKitchenOperator, withKdsAuth } from './kds-auth';

function context(role: string, deny = false) {
  const capabilities = RESTAURANT_JOB_ROLE_TEMPLATES.find(
    (template) => template.key === role
  )!.capabilities;
  const db = {
    restaurantStaffJobRole: {
      findMany: vi.fn(async () => [
        { jobRole: { capabilities: capabilities.map((capability) => ({ capability })) } },
      ]),
    },
    restaurantStaffCapabilityGrant: {
      findMany: vi.fn(async () =>
        deny ? [{ capability: 'kitchen:operate', effect: 'DENY' }] : []
      ),
    },
  } as unknown as ScopedDb;
  return {
    db,
    session: { activeStaffProfileId: 'operator' },
    state: 'UNLOCKED',
    device: { branchId: 'branch' },
  } as TerminalContext;
}

it.each(['kitchen', 'cashier', 'server'])('gates KDS reads and actions for %s', async (role) => {
  const ctx = context(role);
  const handler = vi.fn(async () => new Response('ok'));
  const route = withKdsAuth(handler) as unknown as (
    ctx: TerminalContext,
    request: Request
  ) => Promise<Response>;
  const response = await route(ctx, new Request('http://localhost/api/restaurant/kds/queue'));
  expect(response.status).toBe(role === 'kitchen' ? 200 : 403);
  expect(handler).toHaveBeenCalledTimes(role === 'kitchen' ? 1 : 0);
  expect(ctx.db.restaurantStaffJobRole.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ staffProfileId: 'operator', branchId: 'branch' }),
    })
  );
});
it('refuses a locked display and immediately honors a kitchen DENY', async () => {
  const ctx = context('kitchen');
  ctx.state = 'LOCKED';
  expect((await requireKitchenOperator(ctx))?.status).toBe(401);
  expect((await requireKitchenOperator(context('kitchen', true)))?.status).toBe(403);
});
