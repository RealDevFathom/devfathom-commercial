import { beforeEach, expect, it, vi } from 'vitest';
import type { TerminalContext } from './terminal-auth';
const mocks = vi.hoisted(() => ({ capable: vi.fn(), authenticate: vi.fn(), bind: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./job-roles', () => ({ staffHasCapability: mocks.capable }));
vi.mock('./terminal-auth', () => ({
  withTerminalAuth: (handler: unknown) => handler,
  authenticateOperator: mocks.authenticate,
}));
vi.mock('./terminal-session', () => ({ bindOperator: mocks.bind }));
vi.mock('./terminal-audit', () => ({ recordTerminalOperatorAudit: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => ({ ok: true }) }));
import { POST as unlock } from '@/app/api/restaurant/terminal/unlock/route';
import { POST as switchOperator } from '@/app/api/restaurant/terminal/switch/route';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ ok: true });
  mocks.bind.mockResolvedValue({ id: 'session', activeStaffProfileId: 'operator' });
});
it.each(['kitchen', 'cashier', 'server'])(
  'accepts only kitchen capability on unlock and switch (%s)',
  async (role) => {
    mocks.capable.mockResolvedValue(role === 'kitchen');
    for (const [route, state] of [
      [unlock, 'LOCKED'],
      [switchOperator, 'UNLOCKED'],
    ] as const) {
      const ctx = {
        db: {},
        device: { id: 'device', kind: 'KDS', branchId: 'branch' },
        session: { id: 'session', activeStaffProfileId: 'previous' },
        state,
      } as TerminalContext;
      const request = new Request('http://localhost/api/restaurant/terminal/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffProfileId: 'operator', type: 'PIN', secret: '4821' }),
      });
      const handler = route as unknown as (
        ctx: TerminalContext,
        request: Request
      ) => Promise<Response>;
      expect((await handler(ctx, request)).status).toBe(role === 'kitchen' ? 200 : 403);
    }
    expect(mocks.authenticate).toHaveBeenCalledTimes(role === 'kitchen' ? 2 : 0);
    expect(mocks.bind).toHaveBeenCalledTimes(role === 'kitchen' ? 2 : 0);
  }
);
