/**
 * team.adminResetPassword — manual (admin-set) password resets.
 *
 * Regression: the reset revokes pending invitations, but an admin-set password
 * cannot sign in an INVITED member and self-service recovery excludes them. The
 * reset therefore stranded the member with no onboarding path. It is refused
 * for invited members before any credential changes; active members keep the
 * existing reset-and-revoke behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  apiTokenDeleteMany: vi.fn(),
  ticketDeleteMany: vi.fn(),
  resetUpdateMany: vi.fn(),
  invitationUpdateMany: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const app = router({ team: teamRouter });
const NEW_PASSWORD = ['Temp', 'Reset', '2026', 'Value!'].join('-');

function caller() {
  const db = {
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    apiToken: { deleteMany: mocks.apiTokenDeleteMany },
    tenantSsoTicket: { deleteMany: mocks.ticketDeleteMany },
    passwordResetToken: { updateMany: mocks.resetUpdateMany },
    invitation: { updateMany: mocks.invitationUpdateMany },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return app.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['hr'],
      modules: [{ key: 'hr', name: 'HR', enabled: true }],
      activeSeats: 1,
      seatLimit: 50,
    },
    session: {
      expires: 'later',
      user: { id: 'admin_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userUpdate.mockResolvedValue({ name: 'Member' });
});

describe('team.adminResetPassword', () => {
  it('resets an active member and revokes their credentials', async () => {
    mocks.userFindFirst.mockResolvedValue({ status: 'ACTIVE' });
    await expect(
      caller().adminResetPassword({ id: 'member_1', newPassword: NEW_PASSWORD })
    ).resolves.toEqual({ success: true });
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { id: 'member_1', organizationId: 'org_1' },
      select: { status: true },
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member_1' },
        data: expect.objectContaining({ password: 'hashed', mustChangePassword: true }),
      })
    );
    const where = { organizationId: 'org_1', userId: 'member_1' };
    expect(mocks.invitationUpdateMany).toHaveBeenCalledWith({
      where: { ...where, acceptedAt: null },
      data: { expiresAt: new Date(0) },
    });
    expect(mocks.apiTokenDeleteMany).toHaveBeenCalledWith({ where });
  });

  it('refuses an invited member before touching credentials or the invitation', async () => {
    mocks.userFindFirst.mockResolvedValue({ status: 'INVITED' });
    await expect(
      caller().adminResetPassword({ id: 'member_1', newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.resetUpdateMany).not.toHaveBeenCalled();
    expect(mocks.apiTokenDeleteMany).not.toHaveBeenCalled();
    expect(mocks.ticketDeleteMany).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for a member outside the organization', async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    await expect(
      caller().adminResetPassword({ id: 'member_x', newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
