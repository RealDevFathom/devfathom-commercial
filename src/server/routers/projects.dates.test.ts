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
  user: { count: vi.fn() },
  client: { count: vi.fn() },
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

beforeEach(() => vi.clearAllMocks());

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
});
