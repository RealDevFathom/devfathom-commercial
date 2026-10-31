// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../authz', () => ({
  assertProjectAccess: vi.fn(),
  assertBoardAccess: vi.fn(),
  assertColumnAccess: vi.fn(),
  assertTaskAccess: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => ''), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';

const projectCreate = vi.fn();
const projectUpdate = vi.fn();
const projectFindUniqueOrThrow = vi.fn();
const db = {
  project: {
    create: projectCreate,
    update: projectUpdate,
    findUniqueOrThrow: projectFindUniqueOrThrow,
  },
  user: { findMany: vi.fn() },
  client: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};

function caller() {
  return projectsRouter.createCaller({
    db,
    session: { user: { id: 'user-1', role: 'ADMIN', status: 'ACTIVE' } },
    organization: { id: 'org-1' },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
  projectCreate.mockResolvedValue({ id: 'project-1', name: 'Project' });
  projectUpdate.mockResolvedValue({ id: 'project-1', name: 'Project' });
  db.$transaction.mockImplementation(async (run) => run(db));
});

describe('project date validation', () => {
  it('rejects create when the end date precedes the start date', async () => {
    await expect(
      caller().create({
        name: 'Invalid project',
        type: 'INTERNAL',
        startDate: new Date('2026-10-22T00:00:00.000Z'),
        endDate: new Date('2026-10-21T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('rejects a partial update whose end date precedes the stored start date', async () => {
    projectFindUniqueOrThrow.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: null,
    });

    await expect(
      caller().update({ id: 'project-1', endDate: new Date('2026-10-21T00:00:00.000Z') })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'End date must be on or after the start date.',
    });

    expect(db.$queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM projects WHERE id = ', ' FOR UPDATE'],
      'project-1'
    );
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      projectFindUniqueOrThrow.mock.invocationCallOrder[0]
    );
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('rejects a partial update whose start date follows the stored end date', async () => {
    projectFindUniqueOrThrow.mockResolvedValue({
      startDate: null,
      endDate: new Date('2026-10-22T00:00:00.000Z'),
    });

    await expect(
      caller().update({ id: 'project-1', startDate: new Date('2026-10-23T00:00:00.000Z') })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('allows unrelated edits on a legacy project with reversed dates', async () => {
    projectFindUniqueOrThrow.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: new Date('2026-10-21T00:00:00.000Z'),
    });

    await expect(
      caller().update({ id: 'project-1', name: 'Renamed', status: 'COMPLETED' })
    ).resolves.toMatchObject({ id: 'project-1' });
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { name: 'Renamed', status: 'COMPLETED' },
    });
  });

  it.each(['startDate', 'endDate'] as const)('allows clearing %s', async (field) => {
    projectFindUniqueOrThrow.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: new Date('2026-10-21T00:00:00.000Z'),
    });

    await expect(caller().update({ id: 'project-1', [field]: null })).resolves.toMatchObject({
      id: 'project-1',
    });
  });

  it('allows repairing reversed dates with equal start and end dates', async () => {
    projectFindUniqueOrThrow.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: new Date('2026-10-21T00:00:00.000Z'),
    });
    const date = new Date('2026-10-23T00:00:00.000Z');

    await expect(
      caller().update({ id: 'project-1', startDate: date, endDate: date })
    ).resolves.toMatchObject({ id: 'project-1' });
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { startDate: date, endDate: date },
    });
  });

  it.each([
    {},
    { startDate: new Date('2026-10-21T00:00:00.000Z') },
    { endDate: new Date('2026-10-22T00:00:00.000Z') },
    {
      startDate: new Date('2026-10-21T00:00:00.000Z'),
      endDate: new Date('2026-10-22T00:00:00.000Z'),
    },
    {
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: new Date('2026-10-22T00:00:00.000Z'),
    },
  ])('allows creating a project with valid optional dates: %o', async (dates) => {
    await expect(
      caller().create({ name: 'Project', type: 'INTERNAL', createDefaultBoard: false, ...dates })
    ).resolves.toMatchObject({ id: 'project-1' });
    expect(projectCreate).toHaveBeenCalledOnce();
  });

  it('serializes concurrent partial date edits before validating the stored dates', async () => {
    let dates = {
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T00:00:00.000Z'),
    };
    projectFindUniqueOrThrow.mockImplementation(async () => ({ ...dates }));
    projectUpdate.mockImplementation(async ({ data }) => {
      dates = { ...dates, ...data };
      return { id: 'project-1', name: 'Project', ...dates };
    });
    let lock = Promise.resolve();
    db.$transaction.mockImplementation(async (run) => {
      let release: (() => void) | undefined;
      const tx = {
        project: db.project,
        $queryRaw: vi.fn(async () => {
          const previous = lock;
          lock = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          return [{ id: 'project-1' }];
        }),
      };
      try {
        return await run(tx);
      } finally {
        release?.();
      }
    });

    const results = await Promise.allSettled([
      caller().update({ id: 'project-1', startDate: new Date('2026-10-25T00:00:00.000Z') }),
      caller().update({ id: 'project-1', endDate: new Date('2026-10-05T00:00:00.000Z') }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'BAD_REQUEST', message: 'End date must be on or after the start date.' },
    });
    expect(dates.endDate.getTime()).toBeGreaterThanOrEqual(dates.startDate.getTime());
    expect(projectUpdate).toHaveBeenCalledOnce();
  });
});
