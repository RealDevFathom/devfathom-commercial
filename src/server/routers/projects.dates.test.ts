import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { projectsRouter } from './projects';

const projectCreate = vi.fn();
const projectFindUnique = vi.fn();
const projectUpdate = vi.fn();
const membershipFindUnique = vi.fn();
const userFindMany = vi.fn();
const db = {
  project: { create: projectCreate, findUnique: projectFindUnique, update: projectUpdate },
  projectMember: { findUnique: membershipFindUnique },
  user: { findMany: userFindMany },
  client: { findMany: vi.fn() },
};

function caller() {
  return projectsRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role: 'EMPLOYEE',
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('project date ranges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membershipFindUnique.mockResolvedValue({ role: 'MEMBER' });
    userFindMany.mockResolvedValue([{ id: 'user_1' }]);
  });

  it('rejects an invalid range when creating a project', async () => {
    await expect(
      caller().create({
        name: 'Invalid dates',
        type: 'INTERNAL',
        startDate: new Date('2026-10-22T00:00:00.000Z'),
        endDate: new Date('2026-10-21T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('End date must be on or after start date'),
    });
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('accepts equal dates and omitted bounds when creating a project', async () => {
    const date = new Date('2026-10-22T00:00:00.000Z');
    projectCreate.mockResolvedValue({ id: 'project_1', name: 'Valid dates' });

    await caller().create({
      name: 'Valid dates',
      type: 'INTERNAL',
      startDate: date,
      endDate: date,
      createDefaultBoard: false,
    });
    await caller().create({
      name: 'No schedule',
      type: 'INTERNAL',
      createDefaultBoard: false,
    });

    expect(projectCreate).toHaveBeenCalledTimes(2);
  });

  it('checks a partial update against the stored start date', async () => {
    projectFindUnique.mockResolvedValue({
      startDate: new Date('2026-10-22T00:00:00.000Z'),
      endDate: null,
    });

    await expect(
      caller().update({ id: 'project_1', endDate: new Date('2026-10-21T00:00:00.000Z') })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(projectFindUnique).toHaveBeenCalledWith({
      where: { id: 'project_1', organizationId: 'org_1' },
      select: { startDate: true, endDate: true },
    });
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('checks a partial update against the stored end date', async () => {
    projectFindUnique.mockResolvedValue({
      startDate: null,
      endDate: new Date('2026-10-21T00:00:00.000Z'),
    });

    await expect(
      caller().update({ id: 'project_1', startDate: new Date('2026-10-22T00:00:00.000Z') })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(projectFindUnique).toHaveBeenCalledWith({
      where: { id: 'project_1', organizationId: 'org_1' },
      select: { startDate: true, endDate: true },
    });
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('scopes a valid partial update to the caller organization', async () => {
    const endDate = new Date('2026-10-20T00:00:00.000Z');
    projectFindUnique.mockResolvedValue({
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: null,
    });
    projectUpdate.mockResolvedValue({ id: 'project_1', name: 'Project' });

    await caller().update({ id: 'project_1', endDate });

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: 'project_1', organizationId: 'org_1' },
      data: { endDate },
    });
  });

  it('allows either stored bound to be cleared', async () => {
    projectFindUnique.mockResolvedValue({
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: new Date('2026-10-20T00:00:00.000Z'),
    });
    projectUpdate.mockResolvedValue({ id: 'project_1', name: 'Project' });

    await caller().update({ id: 'project_1', startDate: null });
    await caller().update({ id: 'project_1', endDate: null });

    expect(projectUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'project_1', organizationId: 'org_1' },
      data: { startDate: null },
    });
    expect(projectUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 'project_1', organizationId: 'org_1' },
      data: { endDate: null },
    });
  });
});
