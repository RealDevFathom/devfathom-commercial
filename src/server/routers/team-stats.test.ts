// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));

import { teamStatsRouter } from './team-stats';

const now = new Date('2026-11-15T12:00:00Z');
const day = 86_400_000;
const ago = (days: number) => new Date(now.getTime() - days * day);
const user = { id: 'member', name: 'Member', avatar: null, title: null, lastActiveAt: null };
const tasks = [
  // Editing this old completion today must not make it a new completion.
  { id: 'old', createdAt: ago(24), completedAt: ago(20), updatedAt: now },
  { id: 'last-week', createdAt: ago(14), completedAt: ago(10), updatedAt: now },
  { id: 'recent', createdAt: ago(6), completedAt: ago(2), updatedAt: now },
  // Migration must not guess a completion time for legacy Done tasks.
  { id: 'unknown', createdAt: ago(90), completedAt: null, updatedAt: now },
].map((task) => ({ ...task, assignees: [{ userId: user.id }], column: { name: 'Done' } }));

type Where = {
  column?: { name: string | { not: string } };
  dueDate?: unknown;
  completedAt?: { gte?: Date; lt?: Date; not?: null };
  updatedAt?: { gte?: Date; lt?: Date };
};
function matchingTasks({ where }: { where: Where }) {
  return tasks.filter((task) => {
    if (where.dueDate || typeof where.column?.name === 'object') return false;
    for (const field of ['completedAt', 'updatedAt'] as const) {
      const range = where[field];
      if (!range) continue;
      const at = task[field];
      if (!at) return false;
      if (range.gte && at < range.gte) return false;
      if (range.lt && at >= range.lt) return false;
    }
    return true;
  });
}
const db = {
  user: { findMany: vi.fn(async () => [user]), findUnique: vi.fn(async () => user) },
  task: {
    findMany: vi.fn(async (args: { where: Where }) => matchingTasks(args)),
    count: vi.fn(async (args: { where: Where }) => matchingTasks(args).length),
  },
  meetingAttendee: { findMany: vi.fn(async () => []) },
  meetingAttendanceLog: { findMany: vi.fn(async () => []) },
  note: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
  projectMember: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
  taskComment: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
};
function caller() {
  return teamStatsRouter.createCaller({
    db,
    session: { user: { id: user.id, role: 'ADMIN', status: 'ACTIVE' } },
    entitlements: { enabledModules: ['team'] },
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('completion metrics', () => {
  it('uses transition times for team counts, sparkline, cycle time and velocity after edits', async () => {
    const result = await caller().getAll();
    expect(result.members[0]).toMatchObject({
      completedThisWeek: 1,
      completedLastWeek: 1,
      avgCycleTimeDays: 4,
      tasksDoneSparkline: [0, 0, 0, 0, 1, 0, 0],
    });
    expect(result.velocity.filter((entry) => entry.count > 0)).toEqual([
      { date: ago(20).toISOString().slice(0, 10), count: 1 },
      { date: ago(10).toISOString().slice(0, 10), count: 1 },
      { date: ago(2).toISOString().slice(0, 10), count: 1 },
    ]);
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ completedAt: { not: null } }),
        orderBy: { completedAt: 'desc' },
      })
    );
  });

  it('uses the same transition times for personal stats and excludes unknown cycle times', async () => {
    const result = await caller().getForUser({ userId: user.id });
    expect(result).toMatchObject({
      completedThisWeek: 1,
      completedLastWeek: 1,
      avgCycleTimeDays: 4,
      tasksDoneSparkline: [0, 0, 0, 0, 1, 0, 0],
    });
  });
});
