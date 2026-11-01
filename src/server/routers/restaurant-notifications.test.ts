import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  staffFindFirst: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationFindFirst: vi.fn(),
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
  settingFindMany: vi.fn(),
  settingFindFirst: vi.fn(),
  settingUpdate: vi.fn(),
  settingCreate: vi.fn(),
  webhookFindFirst: vi.fn(),
  webhookUpdate: vi.fn(),
  webhookCreate: vi.fn(),
  webhookDelete: vi.fn(),
  jobFindMany: vi.fn(),
  jobFindFirst: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  annotateAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(() => 'ciphertext-only') }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    annotateAudit: (...args: Parameters<typeof actual.annotateAudit>) => {
      mocks.annotateAudit(...args);
      actual.annotateAudit(...args);
    },
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: (...args: Parameters<typeof actual.recordTrpcAudit>) => {
      const [entry] = args;
      mocks.recordTrpcAudit({
        ...entry,
        input: entry.ctx.audit?.detail.skipInput ? '[skipped]' : entry.input,
      });
    },
  };
});
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { restaurantNotificationsRouter } from './restaurant-notifications';

const db = {
  restaurantBranch: {
    findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
      (where?.id?.in ?? []).map((id) => ({ id }))
    ),
  },
  restaurantStaffProfile: { findFirst: mocks.staffFindFirst },
  restaurantNotification: {
    findMany: mocks.notificationFindMany,
    findFirst: mocks.notificationFindFirst,
    count: mocks.notificationCount,
    updateMany: mocks.notificationUpdateMany,
  },
  restaurantNotificationChannelSetting: {
    findMany: mocks.settingFindMany,
    findFirst: mocks.settingFindFirst,
    update: mocks.settingUpdate,
    create: mocks.settingCreate,
  },
  restaurantNotificationWebhook: {
    findFirst: mocks.webhookFindFirst,
    update: mocks.webhookUpdate,
    create: mocks.webhookCreate,
    delete: mocks.webhookDelete,
  },
  restaurantJob: {
    findMany: mocks.jobFindMany,
    findFirst: mocks.jobFindFirst,
    create: mocks.jobCreate,
    updateMany: mocks.jobUpdateMany,
  },
  $queryRaw: mocks.queryRaw,
  $transaction: vi.fn(async (work) => work(db)),
};

function caller() {
  return restaurantNotificationsRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.staffFindFirst.mockResolvedValue({ id: 'staff_1' });
  mocks.notificationFindMany.mockResolvedValue([]);
  mocks.notificationFindFirst.mockResolvedValue({
    id: 'notification_1',
    isRead: false,
    readAt: null,
  });
  mocks.notificationCount.mockResolvedValue(2);
  mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settingFindMany.mockResolvedValue([]);
  mocks.settingFindFirst.mockResolvedValue(null);
  mocks.webhookFindFirst.mockResolvedValue(null);
  mocks.jobFindMany.mockResolvedValue([]);
  mocks.jobFindFirst.mockResolvedValue(null);
  mocks.jobCreate.mockImplementation(async ({ data }) => ({ id: 'job_new', ...data }));
  mocks.jobUpdateMany.mockResolvedValue({ count: 2 });
  mocks.queryRaw.mockResolvedValue([{ id: 'job_retry', status: 'QUEUED' }]);
  mocks.settingCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'setting_1',
    ...data,
  }));
});

describe('recipient notifications', () => {
  it('lists only the session-linked staff profile and rejects unknown input', async () => {
    await caller().list({ limit: 20, unreadOnly: true });
    expect(mocks.staffFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(mocks.notificationFindMany.mock.calls[0]?.[0].where).toMatchObject({
      recipientStaffProfileId: 'staff_1',
      isRead: false,
      deliveries: { some: { channel: 'IN_APP', status: 'DELIVERED_IN_APP' } },
    });
    await expect(caller().list({ limit: 20, unknown: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('counts unread notifications', async () => {
    await expect(caller().unreadCount({})).resolves.toEqual({ count: 2 });
    expect(mocks.notificationCount.mock.calls[0]?.[0].where).toMatchObject({
      recipientStaffProfileId: 'staff_1',
      isRead: false,
    });
  });

  it('marks one owned notification and all owned notifications read', async () => {
    const one = await caller().markRead({ id: 'notification_1' });
    expect(one).toMatchObject({ id: 'notification_1', isRead: true });
    expect(mocks.notificationUpdateMany.mock.calls[0]?.[0].where).toEqual({
      id: 'notification_1',
      recipientStaffProfileId: 'staff_1',
    });

    const all = await caller().markAllRead({});
    expect(all).toMatchObject({ count: 1 });
    expect(mocks.notificationUpdateMany.mock.calls[1]?.[0].where).toMatchObject({
      recipientStaffProfileId: 'staff_1',
      isRead: false,
    });
  });

  it('fails closed without a linked staff profile', async () => {
    mocks.staffFindFirst.mockResolvedValue(null);
    await expect(caller().unreadCount({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('notification matrix administration', () => {
  it('reads effective defaults and creates a branch override through staff:manage', async () => {
    await expect(
      caller().getMatrix({ category: 'sop.escalation', branchId: 'branch_1' })
    ).resolves.toMatchObject({
      channels: [
        { channel: 'IN_APP', enabled: true },
        { channel: 'WEBHOOK', enabled: true },
        { channel: 'EMAIL', enabled: true },
        { channel: 'SMS', enabled: true },
        { channel: 'PUSH', enabled: true },
        { channel: 'WHATSAPP', enabled: true },
      ],
    });
    await expect(
      caller().updateMatrix({
        category: 'sop.escalation',
        branchId: 'branch_1',
        channel: 'PUSH',
        enabled: false,
      })
    ).resolves.toMatchObject({ id: 'setting_1', enabled: false });
  });

  it('requires staff:manage', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().getMatrix({ category: 'sop.escalation', branchId: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('signed webhook administration', () => {
  it('configures and rotates a write-only encrypted secret, then lists redacted status', async () => {
    mocks.webhookFindFirst.mockResolvedValueOnce(null);
    mocks.webhookCreate.mockResolvedValue({
      id: 'config_1',
      endpointUrl: 'https://93.184.216.34/hook',
      enabled: true,
      updatedAt: new Date(),
    });
    await caller().configureWebhook({
      endpointUrl: 'https://93.184.216.34/hook',
      enabled: true,
      signingSecret: 'a-signing-secret-with-at-least-32-characters',
    });
    expect(mocks.webhookCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ encryptedSigningSecret: 'ciphertext-only' }),
        select: expect.not.objectContaining({ encryptedSigningSecret: true }),
      })
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      action: 'CONFIGURE_RESTAURANT_NOTIFICATION_WEBHOOK',
      targetType: 'RestaurantNotificationWebhook',
      skipInput: true,
    });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ input: '[skipped]' })
    );
    expect(JSON.stringify(mocks.recordTrpcAudit.mock.calls)).not.toContain(
      'a-signing-secret-with-at-least-32-characters'
    );

    mocks.webhookFindFirst.mockResolvedValueOnce({ id: 'config_1' });
    mocks.webhookUpdate.mockResolvedValue({
      id: 'config_1',
      endpointUrl: 'https://93.184.216.34/hook',
      enabled: true,
      updatedAt: new Date(),
    });
    await caller().configureWebhook({
      endpointUrl: 'https://93.184.216.34/hook',
      enabled: true,
      signingSecret: 'a-different-secret-with-at-least-32-characters',
    });
    expect(JSON.stringify(mocks.webhookUpdate.mock.calls)).not.toContain('a-different-secret');

    mocks.webhookFindFirst.mockResolvedValueOnce({
      id: 'config_1',
      endpointUrl: 'https://93.184.216.34/hook',
      enabled: true,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailure: null,
      updatedAt: new Date(),
    });
    mocks.jobFindMany
      .mockResolvedValueOnce([{ id: 'recent_1', status: 'SUCCEEDED' }])
      .mockResolvedValueOnce([
        {
          id: 'dead_older_than_recent_window',
          status: 'DEAD',
          payload: { eventId: 'event_9', attemptOffset: 0, version: '1.0', synthetic: true },
        },
      ])
      .mockResolvedValueOnce([]);
    const status = await caller().webhookStatus({});
    expect(status.config).toMatchObject({ signingSecretConfigured: true });
    expect(status.deadLetters).toEqual([
      expect.objectContaining({
        id: 'dead_older_than_recent_window',
        status: 'DEAD',
        successor: null,
      }),
    ]);
    expect(status.deadLetters[0]).not.toHaveProperty('payload');
    expect(status.deadLetterNextCursor).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('ciphertext-only');
    expect(mocks.jobFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          type: 'notification.webhook.deliver.v1',
          status: { not: 'DEAD' },
        },
        take: 20,
      })
    );
    expect(mocks.jobFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { type: 'notification.webhook.deliver.v1', status: 'DEAD' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 26,
      })
    );
  });

  it('pages dead letters with a cursor and reports retry successor outcomes', async () => {
    mocks.webhookFindFirst.mockResolvedValueOnce(null);
    const dead = (id: string) => ({
      id,
      status: 'DEAD',
      attempts: 5,
      nextAttemptAt: new Date(),
      lastError: 'HTTP 503',
      createdAt: new Date(),
      payload: { eventId: `event_${id}`, attemptOffset: 0, version: '1.0', synthetic: true },
    });
    mocks.jobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dead('d1'), dead('d2'), dead('d3')])
      .mockResolvedValueOnce([
        {
          id: 'retry_d1',
          status: 'SUCCEEDED',
          idempotencyKey: 'notification-webhook:event_d1:retry:d1',
        },
      ]);

    const status = await caller().webhookStatus({ deadLetterCursor: 'd0', deadLetterLimit: 2 });

    expect(mocks.jobFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 3, cursor: { id: 'd0' }, skip: 1 })
    );
    expect(mocks.jobFindMany).toHaveBeenNthCalledWith(3, {
      where: {
        type: 'notification.webhook.deliver.v1',
        idempotencyKey: {
          in: ['notification-webhook:event_d1:retry:d1', 'notification-webhook:event_d2:retry:d2'],
        },
      },
      select: { id: true, status: true, idempotencyKey: true },
    });
    expect(status.deadLetters.map((row) => [row.id, row.successor])).toEqual([
      ['d1', { id: 'retry_d1', status: 'SUCCEEDED' }],
      ['d2', null],
    ]);
    expect(status.deadLetterNextCursor).toBe('d2');
  });

  it('deletes the secret-bearing endpoint and dead-letters queued work atomically', async () => {
    mocks.webhookFindFirst.mockResolvedValue({ id: 'config_1' });
    mocks.webhookDelete.mockResolvedValue({ id: 'config_1' });

    await expect(caller().deleteWebhook({ confirmation: 'DELETE' })).resolves.toEqual({
      id: 'config_1',
      stoppedDeliveries: 2,
    });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { type: 'notification.webhook.deliver.v1', status: 'QUEUED' },
      data: {
        status: 'DEAD',
        lastError: 'Webhook endpoint was deleted before delivery.',
      },
    });
    expect(mocks.webhookDelete).toHaveBeenCalledWith({ where: { id: 'config_1' } });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      action: 'DELETE_RESTAURANT_NOTIFICATION_WEBHOOK',
      targetType: 'RestaurantNotificationWebhook',
      targetId: 'config_1',
    });
  });

  it('rejects a non-HTTPS endpoint as a 400 with an actionable message', async () => {
    await expect(
      caller().configureWebhook({
        endpointUrl: 'http://example.com/hook',
        enabled: true,
        signingSecret: 'a-signing-secret-with-at-least-32-characters',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Webhook endpoint must use HTTPS.',
    });
    expect(mocks.webhookCreate).not.toHaveBeenCalled();
    expect(mocks.webhookUpdate).not.toHaveBeenCalled();
  });

  it('queues an allowlisted synthetic test and retries dead jobs without resetting attempts', async () => {
    mocks.webhookFindFirst.mockResolvedValueOnce({ enabled: true });
    await caller().testWebhook({});
    expect(mocks.jobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'notification.webhook.deliver.v1',
        payload: expect.objectContaining({ synthetic: true, attemptOffset: 0 }),
      }),
    });
    expect(mocks.notificationFindFirst).not.toHaveBeenCalled();

    mocks.jobFindFirst.mockResolvedValue({
      id: 'dead_1',
      organizationId: 'org_1',
      attempts: 5,
      payload: {
        eventId: 'event_1',
        notificationId: 'notification_1',
        attemptOffset: 0,
        version: '1.0',
      },
    });
    await expect(caller().retryWebhook({ eventId: 'dead_1' })).resolves.toMatchObject({
      eventId: 'job_retry',
      status: 'QUEUED',
    });
    mocks.queryRaw.mockResolvedValueOnce([{ id: 'job_retry', status: 'SUCCEEDED' }]);
    await expect(caller().retryWebhook({ eventId: 'dead_1' })).resolves.toMatchObject({
      eventId: 'job_retry',
      status: 'SUCCEEDED',
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    const query = mocks.queryRaw.mock.calls[1]?.[0] as TemplateStringsArray;
    const values = mocks.queryRaw.mock.calls[1]?.slice(1) as unknown[];
    expect(query.join(' ')).toContain('ON CONFLICT ("organizationId", "idempotencyKey") DO UPDATE');
    expect(values).toContain('notification-webhook:event_1:retry:dead_1');
    expect(values).toContain(
      JSON.stringify({
        eventId: 'event_1',
        notificationId: 'notification_1',
        attemptOffset: 5,
        version: '1.0',
      })
    );
  });
});
