import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { teamStatsRouter } from './team-stats';

const taskFindMany = vi.fn();

const db = {
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  task: {
    findMany: taskFindMany,
    count: vi.fn(),
  },
  meetingAttendee: { findMany: vi.fn() },
  meetingAttendanceLog: { findMany: vi.fn() },
  note: { groupBy: vi.fn(), count: vi.fn() },
  projectMember: { findMany: vi.fn(), count: vi.fn() },
  taskComment: { groupBy: vi.fn(), count: vi.fn() },
};

const caller = () =>
  teamStatsRouter.createCaller({
    db,
    session: { user: { id: 'member-1', role: 'ADMIN', status: 'ACTIVE' } },
    entitlements: { enabledModules: [] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findMany.mockResolvedValue([
    {
      id: 'member-1',
      name: 'Owner',
      avatar: null,
      title: null,
      lastActiveAt: null,
    },
  ]);
  db.user.findUnique.mockResolvedValue({
    id: 'member-1',
    name: 'Owner',
    avatar: null,
    title: null,
    lastActiveAt: null,
  });
  db.task.count.mockResolvedValue(0);
  db.meetingAttendee.findMany.mockResolvedValue([]);
  db.meetingAttendanceLog.findMany.mockResolvedValue([]);
  db.note.groupBy.mockResolvedValue([]);
  db.note.count.mockResolvedValue(0);
  db.projectMember.findMany.mockResolvedValue([]);
  db.projectMember.count.mockResolvedValue(0);
  db.taskComment.groupBy.mockResolvedValue([]);
  db.taskComment.count.mockResolvedValue(0);
});

describe('team stats completion timestamps', () => {
  it('excludes legacy null timestamps before applying the team cycle-time sample limit', async () => {
    taskFindMany.mockResolvedValue([]);

    await caller().getAll();

    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          column: { name: 'Done' },
          completedAt: { not: null },
          assignees: { some: {} },
        },
        orderBy: { completedAt: 'desc' },
        take: 500,
      })
    );
  });

  it('keeps member stats available when migrated Done tasks have no completion event', async () => {
    const createdAt = new Date('2026-10-20T12:00:00.000Z');
    const completedAt = new Date('2026-10-22T12:00:00.000Z');
    taskFindMany.mockResolvedValueOnce([{ completedAt: null }]).mockResolvedValueOnce([
      { createdAt: new Date('2026-01-01T00:00:00.000Z'), completedAt: null },
      { createdAt, completedAt },
    ]);

    const result = await caller().getForUser({ userId: 'member-1' });

    expect(result.avgCycleTimeDays).toBe(2);
    expect(result.tasksDoneSparkline).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(taskFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          column: { name: 'Done' },
          completedAt: { not: null },
          assignees: { some: { userId: 'member-1' } },
        },
      })
    );
  });
});
