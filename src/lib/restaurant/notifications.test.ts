import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  deliverNotificationRequest,
  notificationRequestSchema,
  resolveNotificationMatrix,
  type NotificationRequestInput,
} from './notifications';

type Row = Record<string, unknown>;

function makeDb(settings: Row[] = []) {
  const notifications = new Map<string, Row>();
  const deliveries = new Map<string, Row>();
  const db = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    restaurantNotificationChannelSetting: {
      findMany: vi.fn(async () => settings),
    },
    restaurantNotification: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          const id = row.id as string;
          if (notifications.has(id)) continue;
          notifications.set(id, { ...row });
          count += 1;
        }
        return { count };
      }),
    },
    restaurantNotificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          const id = row.id as string;
          if (deliveries.has(id)) continue;
          deliveries.set(id, { ...row });
          count += 1;
        }
        return { count };
      }),
    },
  };
  return { db: db as unknown as ScopedDb, notifications, deliveries };
}

const REQUEST: NotificationRequestInput = {
  requestId: 'request_1',
  recipientStaffProfileIds: ['staff_1', 'staff_2', 'staff_1'],
  branchId: 'branch_1',
  category: 'sop.escalation',
  title: 'SOP overdue',
  body: 'Open checklist is late.',
  entityType: 'RestaurantSopOccurrence',
  entityId: 'occ_1',
  channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'],
};

describe('notificationRequestSchema', () => {
  it('rejects unknown fields', () => {
    expect(() => notificationRequestSchema.parse({ ...REQUEST, unknown: true })).toThrow();
  });
});

describe('resolveNotificationMatrix', () => {
  it('uses branch override, then org setting, then enabled-by-absence', async () => {
    const { db } = makeDb([
      { branchId: null, channel: 'EMAIL', enabled: false },
      { branchId: 'branch_1', channel: 'EMAIL', enabled: true },
      { branchId: null, channel: 'SMS', enabled: false },
    ]);

    await expect(resolveNotificationMatrix(db, 'sop.escalation', 'branch_1')).resolves.toEqual({
      IN_APP: true,
      WEBHOOK: true,
      EMAIL: true,
      SMS: false,
      PUSH: true,
      WHATSAPP: true,
    });
  });
});

describe('deliverNotificationRequest', () => {
  it('persists one unread row per recipient and only enabled delivery rows', async () => {
    const { db, notifications, deliveries } = makeDb([
      { branchId: null, channel: 'SMS', enabled: false },
      { branchId: 'branch_1', channel: 'PUSH', enabled: false },
    ]);

    await expect(deliverNotificationRequest(db, REQUEST)).resolves.toEqual({
      notificationCount: 2,
      deliveryCount: 6,
    });
    expect([...notifications.values()]).toHaveLength(2);
    expect([...notifications.values()][0]).toMatchObject({ isRead: false, readAt: null });
    expect([...deliveries.values()].map((row) => [row.channel, row.status])).toEqual([
      ['IN_APP', 'DELIVERED_IN_APP'],
      ['EMAIL', 'STUBBED'],
      ['WHATSAPP', 'STUBBED'],
      ['IN_APP', 'DELIVERED_IN_APP'],
      ['EMAIL', 'STUBBED'],
      ['WHATSAPP', 'STUBBED'],
    ]);
  });

  it('is idempotent for the same request', async () => {
    const { db, notifications, deliveries } = makeDb();
    await deliverNotificationRequest(db, REQUEST);
    await deliverNotificationRequest(db, REQUEST);
    expect(notifications.size).toBe(2);
    expect(deliveries.size).toBe(10);
  });
});
