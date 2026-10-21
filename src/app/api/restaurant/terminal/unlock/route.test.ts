import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  rateLimit: vi.fn(),
  authenticateOperator: vi.fn(),
  operatorHasCapability: vi.fn(),
  bindOperator: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: mocks.rateLimit,
}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));
vi.mock('@/lib/restaurant/terminal-audit', () => ({
  recordTerminalOperatorAudit: mocks.recordAudit,
}));
vi.mock('@/lib/restaurant/terminal-session', () => ({
  bindOperator: mocks.bindOperator,
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
  withTerminalAuth:
    (handler: (ctx: unknown, request: Request) => Promise<Response>) => (request: Request) =>
      handler(
        {
          db: {},
          device: { id: 'kds_1', kind: 'KDS', branchId: 'branch_1' },
          session: { id: 'session_1' },
          state: 'LOCKED',
        },
        request
      ),
}));

import { POST } from './route';

function request(secret: string) {
  return new Request('https://tenant.test/api/restaurant/terminal/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffProfileId: 'staff_1', type: 'PIN', secret }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.rateLimit.mockImplementation(async () => {
    mocks.events.push('rate-limit');
    return { ok: true };
  });
  mocks.authenticateOperator.mockImplementation(async () => {
    mocks.events.push('pin');
    return { ok: true, credentialId: 'credential_1', staffProfileId: 'staff_1' };
  });
  mocks.operatorHasCapability.mockImplementation(async () => {
    mocks.events.push('capability');
    return true;
  });
  mocks.bindOperator.mockResolvedValue({ id: 'session_1', activeStaffProfileId: 'staff_1' });
});

describe('POST terminal unlock KDS capability privacy', () => {
  it('verifies the PIN before checking kitchen access and binds an authorized operator', async () => {
    const response = await POST(request('424242'));

    expect(response.status).toBe(200);
    expect(mocks.events).toEqual(['rate-limit', 'pin', 'capability']);
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      expect.anything(),
      'staff_1',
      'kitchen:operate',
      expect.any(Date),
      'branch_1'
    );
    expect(mocks.bindOperator).toHaveBeenCalledOnce();
  });

  it('returns the wrong-PIN response for a valid PIN without kitchen access', async () => {
    mocks.operatorHasCapability.mockImplementation(async () => {
      mocks.events.push('capability');
      return false;
    });

    const denied = await POST(request('424242'));
    const deniedBody = await denied.json();

    mocks.events.length = 0;
    mocks.authenticateOperator.mockImplementation(async () => {
      mocks.events.push('pin');
      return { ok: false, reason: 'INVALID' };
    });
    const wrongPin = await POST(request('000000'));

    expect({ status: denied.status, body: deniedBody }).toEqual({
      status: wrongPin.status,
      body: await wrongPin.json(),
    });
    expect(denied.status).toBe(401);
    expect(deniedBody).toEqual({ error: 'Invalid operator credential.' });
    expect(mocks.operatorHasCapability).toHaveBeenCalledTimes(1);
    expect(mocks.bindOperator).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(
      1,
      'terminal:cred:kds_1:staff_1',
      10,
      60_000
    );
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(
      2,
      'terminal:cred:kds_1:staff_1',
      10,
      60_000
    );
  });
});
