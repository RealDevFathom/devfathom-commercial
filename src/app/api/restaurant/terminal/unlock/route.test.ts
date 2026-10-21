import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  bind: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/lib/restaurant/terminal-audit', () => ({ recordTerminalOperatorAudit: vi.fn() }));
vi.mock('@/lib/restaurant/shifts', () => ({ describeShiftDenial: vi.fn() }));
vi.mock('@/lib/restaurant/job-roles', () => ({ staffHasCapability: mocks.capability }));
vi.mock('@/lib/restaurant/terminal-session', () => ({ bindOperator: mocks.bind }));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticate,
  withTerminalAuth: (handler: unknown) => handler,
}));

import { POST } from './route';

it('verifies a KDS PIN before returning the same 401 for missing kitchen access', async () => {
  mocks.authenticate.mockResolvedValue({ ok: true, credentialId: 'credential-1' });
  mocks.capability.mockResolvedValue(false);
  const response = await (
    POST as unknown as (ctx: unknown, request: Request) => Promise<Response>
  )(
    {
      state: 'LOCKED',
      db: {},
      device: { id: 'kds-1', kind: 'KDS', branchId: 'branch-1' },
      session: { id: 'session-1' },
    },
    new Request('https://tenant.test/api/restaurant/terminal/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffProfileId: 'staff-1', type: 'PIN', secret: '4242' }),
    })
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Invalid operator credential.' });
  expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.capability.mock.invocationCallOrder[0]!
  );
  expect(mocks.bind).not.toHaveBeenCalled();
});
