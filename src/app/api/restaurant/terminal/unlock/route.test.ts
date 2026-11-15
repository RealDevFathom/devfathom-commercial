import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ctx: {
    state: 'LOCKED',
    organizationId: 'org-1',
    db: {},
    device: { id: 'kds-1', kind: 'KDS', branchId: 'branch-1' },
    session: { id: 'session-1', activeStaffProfileId: null as string | null },
  },
  authenticateOperator: vi.fn(),
  operatorHasCapability: vi.fn(),
  bindOperator: vi.fn(),
  recordTerminalOperatorAudit: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/lib/restaurant/terminal-audit', () => ({
  recordTerminalOperatorAudit: mocks.recordTerminalOperatorAudit,
}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));
vi.mock('@/lib/restaurant/terminal-session', () => ({ bindOperator: mocks.bindOperator }));
vi.mock('@/lib/restaurant/pos-composer-proof', () => ({
  mintPosComposerProof: vi.fn(() => 'composer-proof'),
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
  withTerminalAuth:
    (handler: (context: typeof mocks.ctx, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(mocks.ctx, request),
}));

import { POST } from './route';

function unlock() {
  return POST(
    new Request('https://tenant.test/api/restaurant/terminal/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffProfileId: 'staff-1', type: 'PIN', secret: '4242' }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ctx.device.kind = 'KDS';
  mocks.bindOperator.mockResolvedValue({ id: 'session-1', activeStaffProfileId: 'staff-1' });
});

describe('POST /api/restaurant/terminal/unlock on a kitchen display', () => {
  it('rejects a wrong credential without revealing whether the operator has kitchen access', async () => {
    mocks.authenticateOperator.mockResolvedValue({ ok: false, reason: 'INVALID' });

    const response = await unlock();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid operator credential.' });
    expect(mocks.operatorHasCapability).not.toHaveBeenCalled();
    expect(mocks.bindOperator).not.toHaveBeenCalled();
  });

  it('verifies the credential before checking kitchen access and refuses an operator without it', async () => {
    mocks.authenticateOperator.mockResolvedValue({ ok: true, credentialId: 'credential-1' });
    mocks.operatorHasCapability.mockResolvedValue(false);

    const response = await unlock();

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/kitchen:operate/);
    expect(mocks.authenticateOperator).toHaveBeenCalledTimes(1);
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      mocks.ctx.db,
      'staff-1',
      'kitchen:operate',
      expect.any(Date),
      'branch-1'
    );
    expect(mocks.authenticateOperator.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.operatorHasCapability.mock.invocationCallOrder[0]!
    );
    expect(mocks.bindOperator).not.toHaveBeenCalled();
    expect(mocks.recordTerminalOperatorAudit).not.toHaveBeenCalled();
  });

  it('binds an authenticated operator who has kitchen access', async () => {
    mocks.authenticateOperator.mockResolvedValue({ ok: true, credentialId: 'credential-1' });
    mocks.operatorHasCapability.mockResolvedValue(true);

    const response = await unlock();

    expect(response.status).toBe(200);
    expect(mocks.bindOperator).toHaveBeenCalledWith(
      mocks.ctx.db,
      'session-1',
      'staff-1',
      expect.any(Date)
    );
    expect((await response.json()).session).toEqual({
      id: 'session-1',
      state: 'UNLOCKED',
      activeStaffProfileId: 'staff-1',
    });
  });

  it('does not require kitchen access to unlock a POS terminal', async () => {
    mocks.ctx.device.kind = 'POS';
    mocks.authenticateOperator.mockResolvedValue({ ok: true, credentialId: 'credential-1' });

    const response = await unlock();

    expect(response.status).toBe(200);
    expect(mocks.operatorHasCapability).not.toHaveBeenCalled();
  });
});
