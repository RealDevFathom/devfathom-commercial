import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  hasModule: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(),
  sendEmail: vi.fn(),
  templates: {},
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';
import { verticalForModuleKey } from '@/lib/module-catalog';

const USER_ID = 'restaurant_user';
const notificationProbe = router({ team: teamRouter });

function caller() {
  return notificationProbe.createCaller({
    db: {
      notification: {
        findMany: mocks.findMany,
        findUnique: mocks.findUnique,
        update: mocks.update,
        updateMany: mocks.updateMany,
      },
    },
    entitlements: {
      vertical: verticalForModuleKey('restaurant-core'),
      enabledModules: ['restaurant-core'],
      modules: [{ key: 'hr', name: 'HR', enabled: false }],
    },
    session: {
      expires: 'later',
      user: {
        id: USER_ID,
        organizationId: 'restaurant_org',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'restaurant_org', vertical: verticalForModuleKey('restaurant-core') },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('team shell notifications without HR entitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasModule.mockReturnValue(false);
    mocks.findMany.mockResolvedValue([]);
    mocks.update.mockResolvedValue({ id: 'notification_1', isRead: true });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('keeps the router notification schema equivalent to the entitlement exception set', () => {
    const notificationProcedureNames = Object.keys(teamRouter._def.procedures).filter(
      (name) => name.includes('Notification') && !name.endsWith('NotificationPrefs')
    );
    const exceptionNames = ['getNotifications', 'markNotificationRead', 'markAllNotificationsRead'];

    expect(notificationProcedureNames.sort()).toEqual(exceptionNames.sort());
  });

  it('lists only the active tenant user notifications when HR is disabled', async () => {
    await expect(caller().team.getNotifications()).resolves.toEqual([]);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(mocks.hasModule).not.toHaveBeenCalled();
  });

  it('continues to HR-gate unrelated team procedures', async () => {
    await expect(caller().team.getAll()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The HR module is not enabled for this organization.',
    });
    expect(mocks.hasModule).toHaveBeenCalledWith(expect.any(Object), 'hr');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('marks an owned notification and audits the mutation when HR is disabled', async () => {
    mocks.findUnique.mockResolvedValue({ userId: USER_ID });

    await expect(caller().team.markNotificationRead({ id: 'notification_1' })).resolves.toEqual({
      id: 'notification_1',
      isRead: true,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'notification_1' },
      select: { userId: true },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'notification_1' },
      data: { isRead: true },
    });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'team.markNotificationRead',
        type: 'mutation',
        outcome: 'SUCCESS',
      })
    );
    expect(mocks.hasModule).not.toHaveBeenCalled();
  });

  it('rejects a notification owned by another tenant user without mutating it', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'other_user' });

    await expect(
      caller().team.markNotificationRead({ id: 'notification_1' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'That notification does not belong to you',
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'team.markNotificationRead',
        type: 'mutation',
        outcome: 'FAILURE',
      })
    );
  });

  it('rejects an unknown notification without attempting an update', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(
      caller().team.markNotificationRead({ id: 'missing_notification' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'That notification does not belong to you',
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('marks unread notifications only for the active tenant user', async () => {
    await expect(caller().team.markAllNotificationsRead()).resolves.toEqual({ success: true });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isRead: false },
      data: { isRead: true },
    });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'team.markAllNotificationsRead',
        type: 'mutation',
        outcome: 'SUCCESS',
      })
    );
  });
});
