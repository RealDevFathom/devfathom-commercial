import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { teamStatsRouter } from './team-stats';

const completedAt = new Date('2026-10-01T09:00:00.000Z');
const editedAt = new Date('2026-10-22T09:00:00.000Z');

function caller() {
  const taskFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if ('completedAt' in args.where && (args.where.completedAt as { not?: null }).not === null) {
      return [
        {
          createdAt: new Date('2026-09-29T09:00:00.000Z'),
          completedAt,
          updatedAt: editedAt,
        },
      ];
    }
    if ('updatedAt' in args.where) return [{ completedAt, updatedAt: editedAt }];
    return [];
  });
  const taskCount = vi.fn(async (args: { where: Record<string, unknown> }) =>
    'updatedAt' in args.where ? 1 : 0
  );
  const zero = vi.fn(async () => 0);
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'user_1',
        name: 'Amina',
        avatar: null,
        title: null,
        lastActiveAt: null,
      })),
    },
    task: { findMany: taskFindMany, count: taskCount },
    meetingAttendee: { findMany: vi.fn(async () => []) },
    meetingAttendanceLog: { findMany: vi.fn(async () => []) },
    note: { count: zero },
    projectMember: { count: zero },
    taskComment: { count: zero },
  };

  const context = {
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['hr'],
      modules: [{ key: 'hr', name: 'HR', enabled: true }],
      activeSeats: 1,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;

  return { stats: teamStatsRouter.createCaller(context), taskFindMany, taskCount };
}

describe('team stats completion timestamps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('uses the Done transition time for personal completion and cycle metrics', async () => {
    const { stats, taskFindMany, taskCount } = caller();

    await expect(stats.getForUser({ userId: 'user_1' })).resolves.toMatchObject({
      completedThisWeek: 0,
      completedLastWeek: 0,
      avgCycleTimeDays: 2,
      tasksDoneSparkline: [0, 0, 0, 0, 0, 0, 0],
    });

    const taskQueries = [...taskFindMany.mock.calls, ...taskCount.mock.calls];
    expect(JSON.stringify(taskQueries)).toContain('completedAt');
    expect(JSON.stringify(taskQueries)).not.toContain('updatedAt');
  });
});
