import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  authenticate: vi.fn(),
  rate: vi.fn(),
  capability: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticate,
  withTerminalAuth: (handler: (ctx: unknown, request: Request) => unknown) => (request: Request) =>
    handler(mocks.ctx, request),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rate }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({ operatorHasCapability: mocks.capability }));
vi.mock('@/lib/restaurant/terminal-audit', () => ({ recordTerminalOperatorAudit: mocks.audit }));
import { POST } from './route';
function database() {
  return {
    restaurantStaffProfile: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'owner',
          status: 'ACTIVE',
          user: { role: 'ADMIN', status: 'ACTIVE' },
          jobRoles: [],
        }),
      count: vi.fn().mockResolvedValue(0),
    },
    restaurantCoAuthorization: {
      create: vi
        .fn()
        .mockImplementation(async ({ data }) => ({
          id: 'approval',
          createdAt: new Date(),
          ...data,
        })),
    },
  };
}
let db: ReturnType<typeof database>;
beforeEach(() => {
  vi.clearAllMocks();
  db = database();
  mocks.ctx = {
    db,
    state: 'UNLOCKED',
    device: { id: 'device', branchId: 'branch' },
    session: { id: 'session', activeStaffProfileId: 'owner' },
  };
  mocks.authenticate.mockResolvedValue({ ok: true, staffProfileId: 'owner' });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.capability.mockResolvedValue(true);
});
function request(overrides = {}) {
  return new Request('https://restaurant.test/api/restaurant/terminal/co-authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approvingStaffProfileId: 'owner',
      type: 'PIN',
      secret: '4821',
      capability: 'sop:verify',
      reason: 'Reviewed own work',
      ...overrides,
    }),
  });
}
describe('terminal solo owner approval', () => {
  it('requires PIN reauthentication and persists attributed audit evidence', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(db.restaurantCoAuthorization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actingStaffProfileId: 'owner',
        approvingStaffProfileId: 'owner',
        reason: '[SOLO_OWNER_PIN_REAUTH] Reviewed own work',
      }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      mocks.ctx,
      expect.objectContaining({
        actingStaffProfileId: 'owner',
        metadata: expect.objectContaining({
          coAuthorizationId: 'approval',
          soloOwnerPinReauthenticated: true,
        }),
      })
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('4821');
  });
  it('denies self-approval when a second staff member exists', async () => {
    db.restaurantStaffProfile.count.mockResolvedValue(1);
    expect((await POST(request())).status).toBe(400);
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it('denies BADGE substitution for solo PIN reauthentication', async () => {
    expect((await POST(request({ type: 'BADGE' }))).status).toBe(400);
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it('denies an invalid or locked PIN without writing approval evidence', async () => {
    mocks.authenticate.mockResolvedValue({ ok: false, reason: 'INVALID' });
    expect((await POST(request())).status).toBe(400);
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
  it('preserves distinct manager approval with a branch-scoped credential check', async () => {
    expect((await POST(request({ approvingStaffProfileId: 'manager' }))).status).toBe(201);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ staffProfileId: 'manager', branchId: 'branch' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      mocks.ctx,
      expect.objectContaining({
        metadata: expect.objectContaining({
          soloOwnerPinReauthenticated: false,
          approvingStaffProfileId: 'manager',
        }),
      })
    );
  });
  it('rejects a credential holder without approval capability', async () => {
    mocks.capability.mockResolvedValue(false);
    expect((await POST(request({ approvingStaffProfileId: 'cashier' }))).status).toBe(403);
    expect(db.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });
});
