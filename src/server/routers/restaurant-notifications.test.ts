/**
 * M7-L5 router tests — notifications. Runs the real router against an in-memory db.
 * Covers capability gating, strict-zod unknown-key rejection, recipient inbox
 * (list + unread count), read-state mutations (mark read NOT_FOUND / mark all),
 * and the channel-matrix admin surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { restaurantNotificationsRouter } from './restaurant-notifications';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'cs_new',
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeDb() {
  const db: Record<string, unknown> = {
    restaurantNotification: model(),
    restaurantNotificationDelivery: model(),
    restaurantNotificationChannelSetting: model(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db as Record<string, Delegate> & { $transaction: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
});

function caller() {
  return restaurantNotificationsRouter.createCaller({
    db: db as never,
    entitlements: {
      enabledModules: ['restaurant-sop'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

// ── strict-zod boundary ─────────────────────────────────────────────────────

describe('strict-zod boundary', () => {
  it('rejects an unknown key on list', async () => {
    await expect(
      caller().list({ recipientStaffProfileId: 'staff_1', bogus: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown key on setChannelSetting', async () => {
    await expect(
      caller().setChannelSetting({
        category: 'sop.due',
        channel: 'EMAIL',
        enabled: true,
        bogus: 1,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an out-of-enum channel on setChannelSetting', async () => {
    await expect(
      caller().setChannelSetting({ category: 'sop.due', channel: 'PUSH', enabled: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── capability gating ────────────────────────────────────────────────────────

describe('capability gating', () => {
  it('forbids inbox reads when the capability is denied', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().list({ recipientStaffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('forbids channel-matrix admin when the capability is denied', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().resolveChannelMatrix({ category: 'sop.due' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// ── recipient inbox ──────────────────────────────────────────────────────────

describe('inbox', () => {
  it('lists in-app notifications with the unread count', async () => {
    db.restaurantNotification.findMany.mockResolvedValue([
      {
        id: 'n1',
        category: 'sop.due',
        title: 't',
        body: null,
        entityType: null,
        entityId: null,
        branchId: null,
        isRead: false,
        readAt: null,
        createdAt: new Date(),
      },
    ]);
    db.restaurantNotification.count.mockResolvedValue(3);

    const result = await caller().list({ recipientStaffProfileId: 'staff_1' });
    expect(result.items).toHaveLength(1);
    expect(result.unreadCount).toBe(3);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a lightweight unread count', async () => {
    db.restaurantNotification.count.mockResolvedValue(9);
    const result = await caller().unreadCount({ recipientStaffProfileId: 'staff_1' });
    expect(result).toEqual({ unreadCount: 9 });
  });

  it('marks one notification read', async () => {
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 1 });
    const result = await caller().markRead({
      notificationId: 'n1',
      recipientStaffProfileId: 'staff_1',
    });
    expect(result).toEqual({ found: true, updated: true });
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });

  it('returns NOT_FOUND when marking a notification that is not the recipient’s', async () => {
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 0 });
    db.restaurantNotification.findFirst.mockResolvedValue(null);
    await expect(
      caller().markRead({ notificationId: 'nX', recipientStaffProfileId: 'staff_1' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('marks all read and returns the count', async () => {
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 4 });
    const result = await caller().markAllRead({ recipientStaffProfileId: 'staff_1' });
    expect(result).toEqual({ updated: 4 });
  });
});

// ── channel-matrix admin ─────────────────────────────────────────────────────

describe('channel-matrix admin', () => {
  it('resolves the effective matrix (defaults to all-enabled)', async () => {
    const result = await caller().resolveChannelMatrix({
      branchId: 'branch_1',
      category: 'sop.due',
    });
    expect(result.matrix).toEqual({ IN_APP: true, EMAIL: true, SMS: true, WEBHOOK: true });
  });

  it('lists channel settings', async () => {
    db.restaurantNotificationChannelSetting.findMany.mockResolvedValue([
      { id: 'cs1', branchId: null, category: 'sop.due', channel: 'EMAIL', enabled: false },
    ]);
    const result = await caller().listChannelSettings({ category: 'sop.due' });
    expect(result.items).toHaveLength(1);
  });

  it('sets a channel cell (creates when absent) and audits', async () => {
    db.restaurantNotificationChannelSetting.findFirst.mockResolvedValue(null);
    const result = await caller().setChannelSetting({
      branchId: null,
      category: 'sop.due',
      channel: 'EMAIL',
      enabled: false,
    });
    expect(result).toMatchObject({ category: 'sop.due', channel: 'EMAIL', enabled: false });
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });
});
