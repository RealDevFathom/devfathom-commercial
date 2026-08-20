/**
 * M7-L5 — notifications core unit tests. Covers channel-matrix resolution
 * (branch-override → org-default → default-enabled), fan-out (in-app REAL,
 * external STUBBED, matrix-off suppression, entity-anchored idempotency), the
 * recipient read-state helpers, and the channel-setting upsert.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  NOTIFICATION_CHANNELS,
  deliverViaStub,
  resolveChannelMatrix,
  fanOutNotification,
  listInAppNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  upsertChannelSetting,
} from './notifications';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function makeDb() {
  const db = {
    restaurantNotificationChannelSetting: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cs_new',
        ...data,
      })),
      update: vi
        .fn()
        .mockImplementation(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
            id: where.id,
            branchId: null,
            category: 'c',
            channel: 'IN_APP',
            ...data,
          })
        ),
    } as Delegate,
    restaurantNotification: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'notif_1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    } as Delegate,
    restaurantNotificationDelivery: {
      create: vi.fn().mockResolvedValue({ id: 'del_1' }),
    } as Delegate,
  };
  return db;
}

// ── Channel matrix resolution ───────────────────────────────────────────────

describe('resolveChannelMatrix', () => {
  it('defaults every channel to enabled when no setting rows exist', async () => {
    const db = makeDb();
    const matrix = await resolveChannelMatrix(db as never, { branchId: null, category: 'sop.due' });
    expect(matrix).toEqual({ IN_APP: true, EMAIL: true, SMS: true, WEBHOOK: true });
  });

  it('applies org defaults, and only queries org rows for an org-level request', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findMany.mockResolvedValue([
      { branchId: null, channel: 'EMAIL', enabled: false },
      { branchId: null, channel: 'SMS', enabled: false },
    ]);
    const matrix = await resolveChannelMatrix(db as never, { branchId: null, category: 'sop.due' });
    expect(matrix).toEqual({ IN_APP: true, EMAIL: false, SMS: false, WEBHOOK: true });
    // org-level request must not widen the query to branch rows
    expect(db.restaurantNotificationChannelSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: [{ branchId: null }] }) })
    );
  });

  it('lets a branch override win over the org default', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findMany.mockResolvedValue([
      { branchId: null, channel: 'EMAIL', enabled: true }, // org default ON
      { branchId: 'branch_1', channel: 'EMAIL', enabled: false }, // branch override OFF
      { branchId: 'branch_1', channel: 'IN_APP', enabled: false }, // branch disables in-app
    ]);
    const matrix = await resolveChannelMatrix(db as never, {
      branchId: 'branch_1',
      category: 'sop.due',
    });
    expect(matrix.EMAIL).toBe(false); // branch override wins
    expect(matrix.IN_APP).toBe(false);
    expect(matrix.SMS).toBe(true); // no row → default enabled
  });
});

// ── Stub adapters ────────────────────────────────────────────────────────────

describe('deliverViaStub', () => {
  it('reports STUBBED without any side effect', () => {
    expect(deliverViaStub('EMAIL')).toEqual({ channel: 'EMAIL', status: 'STUBBED' });
    expect(deliverViaStub('SMS')).toEqual({ channel: 'SMS', status: 'STUBBED' });
    expect(deliverViaStub('WEBHOOK')).toEqual({ channel: 'WEBHOOK', status: 'STUBBED' });
  });
});

// ── Fan-out ──────────────────────────────────────────────────────────────────

const REQUEST = {
  recipientStaffProfileId: 'staff_1',
  branchId: 'branch_1',
  category: 'sop.due',
  title: 'SOP due',
  body: 'Open checklist is due.',
  entityType: 'sop.occurrence',
  entityId: 'occ_1',
};

describe('fanOutNotification', () => {
  it('creates one in-app row + a delivery per enabled channel (IN_APP real, rest STUBBED)', async () => {
    const db = makeDb(); // no settings → all channels enabled
    const result = await fanOutNotification(db as never, REQUEST);

    expect(result.created).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.notificationId).toBe('notif_1');
    expect(db.restaurantNotification.create).toHaveBeenCalledTimes(1);
    expect(db.restaurantNotificationDelivery.create).toHaveBeenCalledTimes(4);

    const statuses = result.deliveries.reduce<Record<string, string>>((acc, d) => {
      acc[d.channel] = d.status;
      return acc;
    }, {});
    expect(statuses).toEqual({
      IN_APP: 'DELIVERED_IN_APP',
      EMAIL: 'STUBBED',
      SMS: 'STUBBED',
      WEBHOOK: 'STUBBED',
    });
  });

  it('records NO delivery for a matrix-off channel, and can be external-only', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findMany.mockResolvedValue([
      { branchId: 'branch_1', channel: 'IN_APP', enabled: false }, // in-app off
      { branchId: 'branch_1', channel: 'SMS', enabled: false }, // sms off
      { branchId: 'branch_1', channel: 'WEBHOOK', enabled: false }, // webhook off
      // EMAIL: no row → default enabled
    ]);
    const result = await fanOutNotification(db as never, REQUEST);

    expect(result.created).toBe(true);
    expect(result.deliveries).toEqual([{ channel: 'EMAIL', status: 'STUBBED' }]);
    expect(db.restaurantNotificationDelivery.create).toHaveBeenCalledTimes(1);
    expect(db.restaurantNotificationDelivery.create).toHaveBeenCalledWith({
      data: { notificationId: 'notif_1', channel: 'EMAIL', status: 'STUBBED' },
    });
  });

  it('suppresses entirely (no row, no delivery) when every channel is matrix-off', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findMany.mockResolvedValue(
      NOTIFICATION_CHANNELS.map((channel) => ({ branchId: 'branch_1', channel, enabled: false }))
    );
    const result = await fanOutNotification(db as never, REQUEST);

    expect(result).toEqual({
      notificationId: null,
      created: false,
      suppressed: true,
      deliveries: [],
    });
    expect(db.restaurantNotification.create).not.toHaveBeenCalled();
    expect(db.restaurantNotificationDelivery.create).not.toHaveBeenCalled();
  });

  it('is idempotent for an entity-anchored request (no duplicate on re-run)', async () => {
    const db = makeDb();
    db.restaurantNotification.findFirst.mockResolvedValue({ id: 'notif_existing' });
    const result = await fanOutNotification(db as never, REQUEST);

    expect(result.created).toBe(false);
    expect(result.notificationId).toBe('notif_existing');
    expect(db.restaurantNotification.create).not.toHaveBeenCalled();
    expect(db.restaurantNotificationDelivery.create).not.toHaveBeenCalled();
    // guard keys on recipient + category + entity + title
    expect(db.restaurantNotification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          recipientStaffProfileId: 'staff_1',
          category: 'sop.due',
          entityType: 'sop.occurrence',
          entityId: 'occ_1',
          title: 'SOP due',
        },
      })
    );
  });

  it('does NOT run the idempotency guard when the request has no entity reference', async () => {
    const db = makeDb();
    const { entityType, entityId, ...noEntity } = REQUEST;
    void entityType;
    void entityId;
    await fanOutNotification(db as never, noEntity);
    expect(db.restaurantNotification.findFirst).not.toHaveBeenCalled();
    expect(db.restaurantNotification.create).toHaveBeenCalledTimes(1);
  });
});

// ── Recipient read state ─────────────────────────────────────────────────────

describe('listInAppNotifications', () => {
  it('filters to in-app-delivered rows, returns unread count, and paginates', async () => {
    const db = makeDb();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `n${i}`,
      category: 'sop.due',
      title: 't',
      body: null,
      entityType: null,
      entityId: null,
      branchId: null,
      isRead: false,
      readAt: null,
      createdAt: new Date(),
    }));
    db.restaurantNotification.findMany.mockResolvedValue(rows); // limit 2 + 1 = 3 → hasMore
    db.restaurantNotification.count.mockResolvedValue(7);

    const result = await listInAppNotifications(db as never, {
      recipientStaffProfileId: 'staff_1',
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('n1');
    expect(result.unreadCount).toBe(7);
    expect(db.restaurantNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipientStaffProfileId: 'staff_1',
          deliveries: { some: { channel: 'IN_APP', status: 'DELIVERED_IN_APP' } },
        }),
        take: 3,
      })
    );
  });
});

describe('markNotificationRead', () => {
  it('flips an unread notification and reports updated', async () => {
    const db = makeDb();
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 1 });
    const result = await markNotificationRead(db as never, {
      notificationId: 'n1',
      recipientStaffProfileId: 'staff_1',
    });
    expect(result).toEqual({ found: true, updated: true });
  });

  it('treats an already-read notification as found but not updated (readAt preserved)', async () => {
    const db = makeDb();
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 0 });
    db.restaurantNotification.findFirst.mockResolvedValue({ id: 'n1' });
    const result = await markNotificationRead(db as never, {
      notificationId: 'n1',
      recipientStaffProfileId: 'staff_1',
    });
    expect(result).toEqual({ found: true, updated: false });
  });

  it('reports not-found when the row is not the recipient’s', async () => {
    const db = makeDb();
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 0 });
    db.restaurantNotification.findFirst.mockResolvedValue(null);
    const result = await markNotificationRead(db as never, {
      notificationId: 'n1',
      recipientStaffProfileId: 'staff_1',
    });
    expect(result).toEqual({ found: false, updated: false });
  });
});

describe('markAllNotificationsRead', () => {
  it('returns the number of notifications flipped', async () => {
    const db = makeDb();
    db.restaurantNotification.updateMany.mockResolvedValue({ count: 5 });
    const result = await markAllNotificationsRead(db as never, {
      recipientStaffProfileId: 'staff_1',
    });
    expect(result).toEqual({ updated: 5 });
    expect(db.restaurantNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientStaffProfileId: 'staff_1', isRead: false },
      })
    );
  });
});

// ── Channel-setting upsert ───────────────────────────────────────────────────

describe('upsertChannelSetting', () => {
  it('updates the existing row when one is present', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findFirst.mockResolvedValue({ id: 'cs_1' });
    await upsertChannelSetting(db as never, {
      branchId: null,
      category: 'sop.due',
      channel: 'EMAIL',
      enabled: false,
    });
    expect(db.restaurantNotificationChannelSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cs_1' }, data: { enabled: false } })
    );
    expect(db.restaurantNotificationChannelSetting.create).not.toHaveBeenCalled();
  });

  it('creates a new row (branchId null → org default) when none exists', async () => {
    const db = makeDb();
    db.restaurantNotificationChannelSetting.findFirst.mockResolvedValue(null);
    await upsertChannelSetting(db as never, {
      branchId: 'branch_1',
      category: 'sop.due',
      channel: 'WEBHOOK',
      enabled: true,
    });
    expect(db.restaurantNotificationChannelSetting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { branchId: 'branch_1', category: 'sop.due', channel: 'WEBHOOK', enabled: true },
      })
    );
  });
});
