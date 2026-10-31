/**
 * Account self-service does not need the `hr` module.
 *
 * Regression: in a hotel or pharmacy package (no `hr`), Settings → Profile read the
 * caller through `team.getById` and saved through `team.updateProfile`; both answered
 * FORBIDDEN "The HR module is not enabled for this organization", so Edit did nothing.
 * Reading your own profile is account self-service; reading another member is still
 * the licensed team directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  // The ABAC engine's read of the viewer's custom role and overrides.
  permissions: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { ACCOUNT_PROCEDURES, moduleForProcedure } from '@/lib/module-catalog';
import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const app = router({ team: teamRouter });
const HR_REFUSAL = 'The HR module is not enabled for this organization.';
/** What a member who is neither HR nor Admin is shown of a colleague's work. */
const MEMBER_SCOPE = { projects: 'SHARED', tasks: 'VISIBLE' };
/** The person themself, or an administrator. */
const WHOLE_SCOPE = { projects: 'ALL', tasks: 'ALL' };

function caller(enabledModules: string[], role = 'EMPLOYEE') {
  return app.createCaller({
    db: {
      user: {
        // `can()` reads the viewer's custom permissions through the same delegate;
        // that lookup is answered separately from the member read.
        findUnique: (args: { select?: { permissionOverrides?: unknown } }) =>
          args.select?.permissionOverrides ? mocks.permissions(args) : mocks.findUnique(args),
        findMany: mocks.findMany,
        update: mocks.update,
      },
    },
    entitlements: {
      organizationId: 'org_1',
      enabledModules,
      modules: [{ key: 'hr', name: 'HR', enabled: enabledModules.includes('hr') }],
      activeSeats: 1,
      seatLimit: 50,
    },
    session: {
      expires: 'later',
      user: { id: 'user_self', role, status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ id: 'user_self', name: 'Hotel General Manager' });
  mocks.findMany.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ id: 'user_self', name: 'Hotel GM' });
  mocks.permissions.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('module catalog', () => {
  it('leaves every account self-service procedure unlicensed and the directory on hr', () => {
    for (const path of ACCOUNT_PROCEDURES) expect(moduleForProcedure(path)).toBeNull();
    expect(ACCOUNT_PROCEDURES.has('team.getById')).toBe(true);
    expect(ACCOUNT_PROCEDURES.has('team.updateProfile')).toBe(true);
    expect(ACCOUNT_PROCEDURES.has('team.getNotifications')).toBe(false);
    expect(moduleForProcedure('team.getAll')).toBe('hr');
    expect(moduleForProcedure('team.getRoster')).toBe('hr');
    expect(moduleForProcedure('team.updateRole')).toBe('hr');
    expect(moduleForProcedure('team.getNotifications')).toBeNull();
  });
});

describe('team.getById', () => {
  it('reads the caller without the hr module', async () => {
    await expect(caller([]).getById({ id: 'user_self' })).resolves.toMatchObject({
      id: 'user_self',
    });
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
  });

  it('still refuses another member without the hr module, with the catalog wording', async () => {
    await expect(caller([]).getById({ id: 'user_other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: HR_REFUSAL,
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('reads another member once hr is licensed', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'user_other', name: 'Front desk' });
    await expect(caller(['hr']).getById({ id: 'user_other' })).resolves.toMatchObject({
      id: 'user_other',
    });
  });
});

/**
 * IMP-HR-06: `getAll` shows a colleague's email and phone to HR and Admin only;
 * `getById` must not be the side door that hands them to everyone else.
 */
describe('team.getById directory privacy', () => {
  const colleague = {
    id: 'user_other',
    name: 'Front desk',
    title: 'Receptionist',
    email: 'front.desk@example.test',
    phone: '+92 300 0000001',
  };
  const permissionLookup = expect.objectContaining({
    where: { id: 'user_self' },
    select: expect.objectContaining({ permissionOverrides: expect.anything() }),
  });

  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ ...colleague });
  });

  it('redacts a colleague’s email and phone for a member who is neither HR nor Admin', async () => {
    const member = await caller(['hr']).getById({ id: 'user_other' });

    expect(member).toEqual({ ...colleague, email: '', phone: null, workScope: MEMBER_SCOPE });
    // The read went through the ABAC engine for the viewer, not around it.
    expect(mocks.permissions).toHaveBeenCalledWith(permissionLookup);
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_other' },
        select: expect.objectContaining({ leaveRequests: false }),
      })
    );
  });

  it('shows the contact details to HR, still without the leave history', async () => {
    await expect(caller(['hr'], 'HR').getById({ id: 'user_other' })).resolves.toEqual({
      ...colleague,
      workScope: { projects: 'ALL', tasks: 'VISIBLE' },
    });
    expect(mocks.permissions).toHaveBeenCalledWith(permissionLookup);
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ leaveRequests: false }) })
    );
  });

  it('shows an administrator the contact details and the leave history, as before', async () => {
    await expect(caller(['hr'], 'ADMIN').getById({ id: 'user_other' })).resolves.toEqual({
      ...colleague,
      workScope: WHOLE_SCOPE,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ leaveRequests: expect.objectContaining({ take: 10 }) }),
      })
    );
  });

  it('leaves a member’s own profile whole and asks no directory question', async () => {
    mocks.findUnique.mockResolvedValue({ ...colleague, id: 'user_self' });
    await expect(caller([]).getById({ id: 'user_self' })).resolves.toEqual({
      ...colleague,
      id: 'user_self',
      workScope: WHOLE_SCOPE,
    });
    expect(mocks.permissions).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an override',
      {
        organizationRole: null,
        permissionOverrides: [{ capability: 'team:view', effect: 'DENY' }],
      },
    ],
    [
      'the custom role',
      {
        organizationRole: { permissions: [{ capability: 'team:*', effect: 'DENY' }] },
        permissionOverrides: [],
      },
    ],
  ])('refuses a colleague when %s denies team:view, before reading them', async (_label, rules) => {
    mocks.permissions.mockResolvedValue(rules);
    await expect(caller(['hr'], 'HR').getById({ id: 'user_other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * The rest of a colleague's profile is their work. The projects list shows a
 * non-admin only their own projects (`projects.ts`, `canAccessProject`), and Ask
 * Fathom gives a colleague's project list only to HR, Admin and the person
 * (AI-03) and their tasks only where the viewer may see the task. `getById`
 * reads the same way, in the query itself.
 */
describe('team.getById: a colleague’s projects and tasks', () => {
  const sharedProjects = { project: { members: { some: { userId: 'user_self' } } } };
  const visibleTasks = {
    task: {
      OR: [
        { assignees: { some: { userId: 'user_self' } } },
        { column: { board: { project: { members: { some: { userId: 'user_self' } } } } } },
      ],
    },
  };
  /** The work relations of the member read `getById` issued. */
  function workQuery() {
    const read = mocks.findUnique.mock.calls.find(
      ([args]) =>
        !(args as { select?: { permissionOverrides?: unknown } }).select?.permissionOverrides
    );
    const select = (read?.[0] as { select: Record<string, Record<string, unknown>> }).select;
    return { projects: select.projectMembers!, tasks: select.assignedTasks! };
  }

  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ id: 'user_other', name: 'Front desk' });
  });

  it('reads a member only the projects they share and the tasks they may see', async () => {
    await expect(caller(['hr']).getById({ id: 'user_other' })).resolves.toMatchObject({
      workScope: MEMBER_SCOPE,
    });
    const { projects, tasks } = workQuery();
    expect(projects.where).toEqual(sharedProjects);
    expect(tasks.where).toEqual(visibleTasks);
    expect(tasks.take).toBe(10);
  });

  it('reads HR the whole project list, as for the contact details, but only tasks HR may see', async () => {
    await expect(caller(['hr'], 'HR').getById({ id: 'user_other' })).resolves.toMatchObject({
      workScope: { projects: 'ALL', tasks: 'VISIBLE' },
    });
    const { projects, tasks } = workQuery();
    expect(projects).not.toHaveProperty('where');
    expect(tasks.where).toEqual(visibleTasks);
  });

  it.each([
    ['an administrator', 'user_other', 'ADMIN'],
    ['the person themself', 'user_self', 'EMPLOYEE'],
  ])('reads %s every project and task', async (_label, id, role) => {
    mocks.findUnique.mockResolvedValue({ id, name: 'Front desk' });
    await expect(caller(['hr'], role).getById({ id })).resolves.toMatchObject({
      workScope: WHOLE_SCOPE,
    });
    const { projects, tasks } = workQuery();
    expect(projects).not.toHaveProperty('where');
    expect(tasks).not.toHaveProperty('where');
  });
});

/** `getAll` answers a DENY on `team:view` the way `getById` does. */
describe('team.getAll and team:view', () => {
  const self = { id: 'user_self', name: 'Me', email: 'me@example.test', phone: '+92 300 0000002' };
  const colleague = {
    id: 'user_other',
    name: 'Front desk',
    email: 'front.desk@example.test',
    phone: '+92 300 0000001',
  };

  it('lists the directory, a colleague’s contact details redacted, when team:view is allowed', async () => {
    mocks.findMany.mockResolvedValue([colleague, self]);
    await expect(caller(['hr']).getAll()).resolves.toEqual([
      { ...colleague, email: '', phone: null },
      self,
    ]);
    expect(mocks.permissions).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.anything() })
    );
  });

  it.each([
    [
      'an override',
      {
        organizationRole: null,
        permissionOverrides: [{ capability: 'team:view', effect: 'DENY' }],
      },
    ],
    [
      'the custom role',
      {
        organizationRole: { permissions: [{ capability: 'team:*', effect: 'DENY' }] },
        permissionOverrides: [],
      },
    ],
  ])('reads only the viewer’s own row when %s denies team:view', async (_label, rules) => {
    mocks.permissions.mockResolvedValue(rules);
    mocks.findMany.mockResolvedValue([self]);
    await expect(caller(['hr'], 'HR').getAll()).resolves.toEqual([self]);
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
  });
});

/** The lightweight roster is a directory view and must enforce the same denial. */
describe('team.getRoster and team:view', () => {
  const rosterQuery = {
    select: { id: true, name: true, avatar: true, title: true },
    orderBy: { name: 'asc' },
  };
  const self = { id: 'user_self', name: 'Me', avatar: null, title: 'Engineer' };
  const colleague = {
    id: 'user_other',
    name: 'Front desk',
    avatar: null,
    title: 'Receptionist',
  };

  it('lists the roster when team:view is allowed', async () => {
    mocks.findMany.mockResolvedValue([colleague, self]);

    await expect(caller(['hr']).getRoster()).resolves.toEqual([colleague, self]);
    expect(mocks.permissions).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith(rosterQuery);
  });

  it.each([
    [
      'an override',
      {
        organizationRole: null,
        permissionOverrides: [{ capability: 'team:view', effect: 'DENY' }],
      },
    ],
    [
      'the custom role',
      {
        organizationRole: { permissions: [{ capability: 'team:*', effect: 'DENY' }] },
        permissionOverrides: [],
      },
    ],
  ])('reads only the viewer’s own roster row when %s denies team:view', async (_label, rules) => {
    mocks.permissions.mockResolvedValue(rules);
    mocks.findMany.mockResolvedValue([self]);

    await expect(caller(['hr'], 'HR').getRoster()).resolves.toEqual([self]);
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
      ...rosterQuery,
      where: { id: 'user_self' },
    });
  });

  it('fails closed when the permission lookup fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.permissions.mockRejectedValue(new Error('permission lookup failed'));
    mocks.findMany.mockResolvedValue([self]);

    await expect(caller(['hr']).getRoster()).resolves.toEqual([self]);
    expect(error).toHaveBeenCalledWith(
      '[abac] custom permission lookup for "team:view" threw:',
      expect.any(Error)
    );
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
      ...rosterQuery,
      where: { id: 'user_self' },
    });
  });

  it('fails closed when the permission lookup finds no viewer', async () => {
    mocks.permissions.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([self]);

    await expect(caller(['hr']).getRoster()).resolves.toEqual([self]);
    expect(mocks.permissions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
      ...rosterQuery,
      where: { id: 'user_self' },
    });
  });
});

describe('team.updateProfile', () => {
  it('saves the caller profile without the hr module', async () => {
    await expect(caller([]).updateProfile({ name: 'Hotel GM', skills: [] })).resolves.toMatchObject(
      { id: 'user_self' }
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'user_self' },
      data: { name: 'Hotel GM', skills: [] },
    });
  });
});

describe('team directory procedures', () => {
  it('keep the hr licence', async () => {
    await expect(caller([]).getAll()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: HR_REFUSAL,
    });
  });
});
