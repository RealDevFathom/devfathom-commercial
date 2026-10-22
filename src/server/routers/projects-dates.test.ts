import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assertProjectAccess: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<object>().create();
  return { router: t.router, protectedProcedure: t.procedure };
});
vi.mock('../authz', () => ({
  assertProjectAccess: mocks.assertProjectAccess,
  assertBoardAccess: vi.fn(),
  assertColumnAccess: vi.fn(),
  assertTaskAccess: vi.fn(),
}));
vi.mock('../org-refs', () => ({
  assertInOrganization: vi.fn(),
  workspaceId: vi.fn(() => 'org_1'),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { projectsRouter } from './projects';
import { createProjectSchema } from '@/app/api/v1/projects/route';

const db = {
  project: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
};

const caller = () =>
  projectsRouter.createCaller({
    db,
    session: { user: { id: 'user_1', role: 'ADMIN' } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertProjectAccess.mockResolvedValue(undefined);
});

describe('project date ranges', () => {
  it('rejects an inverted date range from tRPC create', async () => {
    await expect(
      caller().create({
        name: 'Invalid project',
        type: 'INTERNAL',
        startDate: new Date('2026-10-22T00:00:00.000Z'),
        endDate: new Date('2026-10-21T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.project.create).not.toHaveBeenCalled();
  });

  it('rejects a partial tRPC update against the stored start date', async () => {
    db.project.findUnique.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: null,
    });

    await expect(
      caller().update({ id: 'project_1', endDate: new Date('2026-10-21T00:00:00.000Z') })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.assertProjectAccess).toHaveBeenCalledWith(expect.anything(), 'project_1');
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it('rejects an inverted date range from REST input', () => {
    const result = createProjectSchema.safeParse({
      name: 'Invalid project',
      type: 'INTERNAL',
      startDate: '2026-10-22T00:00:00.000Z',
      endDate: '2026-10-21T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['endDate']);
  });
});
