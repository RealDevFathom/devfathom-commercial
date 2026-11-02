import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { EntitlementView } from '@/lib/module-catalog';
import { router, type TRPCContext } from '../trpc';
import { searchRouter } from './search';

const app = router({ search: searchRouter });
const emptyResults = { projects: [], tasks: [], clients: [], notes: [], team: [] };
const records = {
  projects: [{ id: 'project-1', name: 'Match project' }],
  tasks: [{ id: 'task-1', title: 'Match task' }],
  clients: [{ id: 'client-1', name: 'Match client' }],
  notes: [{ id: 'note-1', title: 'Match note' }],
  team: [{ id: 'user-2', name: 'Match colleague' }],
};

/** The viewer's custom role and overrides, as the ABAC engine reads them. */
type PermissionRules = {
  organizationRole: { permissions: Array<{ capability: string; effect: string }> } | null;
  permissionOverrides: Array<{ capability: string; effect: string }>;
};
const NO_CUSTOM_RULES: PermissionRules = { organizationRole: null, permissionOverrides: [] };

function fixture(
  enabledModules: readonly string[],
  vertical: EntitlementView['vertical'] = 'AGENCY',
  role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE',
  rules: PermissionRules = NO_CUSTOM_RULES
) {
  const queries = {
    projects: vi.fn(async () => records.projects),
    tasks: vi.fn(async () => records.tasks),
    clients: vi.fn(async () => records.clients),
    notes: vi.fn(async () => records.notes),
    team: vi.fn(async () => records.team),
  };
  const context = {
    db: {
      project: { findMany: queries.projects },
      task: { findMany: queries.tasks },
      client: { findMany: queries.clients },
      note: { findMany: queries.notes },
      user: { findMany: queries.team, findUnique: vi.fn(async () => rules) },
    },
    entitlements: {
      organizationId: 'org-1',
      vertical,
      enabledModules: [...enabledModules],
      seatLimit: 10,
      activeSeats: 2,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user-1', organizationId: 'org-1', role, status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { context, queries, caller: app.createCaller(context).search };
}

describe('search.global category authorization', () => {
  it.each([
    { module: 'projects', permitted: ['projects', 'tasks'] },
    { module: 'clients', permitted: ['clients'] },
    { module: 'notes', permitted: ['notes'] },
    { module: 'hr', permitted: ['team'] },
  ])(
    'keeps $module search available with only that agency license',
    async ({ module, permitted }) => {
      const { caller, queries } = fixture([module]);
      const result = await caller.global({ query: 'match' });

      for (const category of Object.keys(queries) as Array<keyof typeof queries>) {
        if (permitted.includes(category)) {
          expect(queries[category]).toHaveBeenCalledOnce();
          expect(result[category]).toEqual(records[category]);
        } else {
          expect(queries[category]).not.toHaveBeenCalled();
          expect(result[category]).toEqual([]);
        }
      }
    }
  );

  it('does not load client records through projects without a clients license', async () => {
    const { caller, queries } = fixture(['projects']);
    await caller.global({ query: 'match' });

    expect(queries.projects).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ client: false }) })
    );
    expect(queries.clients).not.toHaveBeenCalled();
  });

  it.each([
    { modules: ['projects', 'clients', 'hr'], notes: false },
    { modules: ['projects', 'clients', 'notes', 'hr'], notes: true },
  ])(
    'keeps shared pharmacy groups with mis-provisioned agency modules: $modules',
    async ({ modules, notes }) => {
      const { caller, queries } = fixture(modules, 'PHARMACY');
      const result = await caller.global({ query: 'match' });

      expect(queries.projects).not.toHaveBeenCalled();
      expect(queries.tasks).not.toHaveBeenCalled();
      expect(queries.clients).not.toHaveBeenCalled();
      expect(queries.team).toHaveBeenCalledOnce();
      expect(queries.notes).toHaveBeenCalledTimes(notes ? 1 : 0);
      expect(result).toEqual({
        ...emptyResults,
        team: records.team,
        notes: notes ? records.notes : [],
      });
    }
  );

  it.each([
    { modules: [], vertical: 'AGENCY' as const },
    { modules: ['projects', 'clients'], vertical: 'PHARMACY' as const },
  ])(
    'returns no groups and makes no record queries with no permitted categories: $vertical',
    async ({ modules, vertical }) => {
      const { caller, queries } = fixture(modules, vertical);

      await expect(caller.global({ query: 'match' })).resolves.toEqual(emptyResults);
      for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
    }
  );

  it('does not authorize categories, modules or vertical supplied by the client', async () => {
    const { caller, queries } = fixture(['hr'], 'PHARMACY');
    const forgedInput = {
      query: 'match',
      categories: ['projects', 'tasks', 'clients', 'notes', 'team'],
      enabledModules: ['projects', 'clients', 'notes', 'hr'],
      vertical: 'AGENCY',
    };

    await expect(caller.global(forgedInput)).resolves.toEqual({
      ...emptyResults,
      team: records.team,
    });
    expect(queries.projects).not.toHaveBeenCalled();
    expect(queries.tasks).not.toHaveBeenCalled();
    expect(queries.clients).not.toHaveBeenCalled();
    expect(queries.notes).not.toHaveBeenCalled();
    expect(queries.team).toHaveBeenCalledOnce();
  });

  it('preserves membership, note visibility, active-directory and result-limit predicates', async () => {
    const { caller, queries } = fixture(['projects', 'clients', 'notes', 'hr']);
    await caller.global({ query: '  match  ' });
    const insensitive = { contains: 'match', mode: 'insensitive' };

    expect(queries.projects).toHaveBeenCalledWith({
      where: { name: insensitive, members: { some: { userId: 'user-1' } } },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        client: { select: { id: true, name: true } },
      },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    });
    expect(queries.tasks).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          title: insensitive,
          column: { board: { project: { members: { some: { userId: 'user-1' } } } } },
        },
        take: 6,
        orderBy: { updatedAt: 'desc' },
      })
    );
    expect(queries.clients).toHaveBeenCalledWith({
      where: { name: insensitive },
      select: { id: true, name: true, industry: true },
      take: 6,
      orderBy: { name: 'asc' },
    });
    expect(queries.notes).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { OR: [{ title: insensitive }, { contentText: insensitive }] },
            {
              OR: [
                { authorId: 'user-1' },
                { visibility: 'TEAM' },
                { visibility: 'SHARED', shares: { some: { userId: 'user-1' } } },
              ],
            },
          ],
        },
        take: 6,
        orderBy: { updatedAt: 'desc' },
      })
    );
    expect(queries.team).toHaveBeenCalledWith({
      where: {
        OR: [{ name: insensitive }, { email: insensitive }, { title: insensitive }],
        status: { not: 'INACTIVE' },
      },
      select: { id: true, name: true, title: true, avatar: true },
      take: 6,
      orderBy: { name: 'asc' },
    });
  });

  it.each([
    {
      label: 'an override',
      rules: {
        organizationRole: null,
        permissionOverrides: [{ capability: 'team:view', effect: 'DENY' }],
      },
    },
    {
      label: 'the custom role',
      rules: {
        organizationRole: { permissions: [{ capability: 'team:*', effect: 'DENY' }] },
        permissionOverrides: [],
      },
    },
  ])('does not search the directory when $label denies team:view', async ({ rules }) => {
    const { caller, queries } = fixture(
      ['projects', 'clients', 'notes', 'hr'],
      'AGENCY',
      'EMPLOYEE',
      rules
    );
    const result = await caller.global({ query: 'match' });

    expect(queries.team).not.toHaveBeenCalled();
    expect(result).toEqual({ ...records, team: [] });
  });

  it('keeps admin project access but does not grant unlicensed groups', async () => {
    const { caller, queries } = fixture(['projects'], 'AGENCY', 'ADMIN');
    await caller.global({ query: 'match' });

    expect(queries.projects).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: { contains: 'match', mode: 'insensitive' } } })
    );
    expect(queries.tasks).toHaveBeenCalledWith(
      expect.objectContaining({ where: { title: { contains: 'match', mode: 'insensitive' } } })
    );
    expect(queries.clients).not.toHaveBeenCalled();
    expect(queries.notes).not.toHaveBeenCalled();
    expect(queries.team).not.toHaveBeenCalled();
  });

  it('makes no queries for blank search text', async () => {
    const { caller, queries } = fixture(['projects', 'clients', 'notes', 'hr']);

    await expect(caller.global({ query: '   ' })).resolves.toEqual(emptyResults);
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
  });

  it('still requires an authenticated session', async () => {
    const { context, queries } = fixture(['projects']);
    const caller = app.createCaller({ ...context, session: null }).search;

    await expect(caller.global({ query: 'match' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
  });
});
