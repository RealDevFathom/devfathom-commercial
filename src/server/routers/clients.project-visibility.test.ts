import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-839 (F22): the client directory is visible to every employee, but the
// projects linked to a client must follow the projects router's rule — admins
// see all of them, everyone else only projects they are a member of — and the
// client detail must not carry project budget, description or other detail.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { clientsRouter } from './clients';

type Row = Record<string, unknown>;
type Args = { where?: Row; select?: Row; include?: Row; take?: number } | true | undefined;

// Minimal Prisma-like evaluator: honours relation `where` (including
// `members: { some: { userId } }`), `select`, `include`, `take` and `_count`.
function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'members') {
      const userId = (value as { some: { userId: string } }).some.userId;
      return (row.members as Row[]).some((m) => m.userId === userId);
    }
    return row[key] === value;
  });
}

function shape(row: Row, args: Args): Row {
  if (!args || args === true) return { ...row };
  const spec = (args.select ?? args.include ?? {}) as Record<string, Args>;
  const out: Row = args.select ? {} : { ...row };
  for (const [key, nested] of Object.entries(spec)) {
    if (key === '_count') {
      const counts: Row = {};
      const relations = (nested as unknown as { select: Record<string, Args> }).select;
      for (const [rel, relArgs] of Object.entries(relations)) {
        const where = relArgs === true ? undefined : relArgs?.where;
        counts[rel] = (row[rel] as Row[]).filter((r) => matches(r, where)).length;
      }
      out._count = counts;
      continue;
    }
    const related = row[key];
    if (Array.isArray(related)) {
      const where = nested === true ? undefined : nested?.where;
      let list = (related as Row[]).filter((r) => matches(r, where));
      if (nested && nested !== true && nested.take !== undefined) list = list.slice(0, nested.take);
      out[key] = list.map((r) => shape(r, nested));
    } else {
      out[key] = nested === true ? related : shape(related as Row, nested);
    }
  }
  return out;
}

const user = (id: string) => ({ id, name: id.toUpperCase(), avatar: null, email: `${id}@x.test` });
const project = (id: string, memberIds: string[]) => ({
  id,
  name: `Project ${id}`,
  status: 'ACTIVE',
  description: `secret plan for ${id}`,
  budget: 50000,
  type: 'WEB',
  techStack: ['ts'],
  members: memberIds.map((userId) => ({ userId, role: 'MEMBER', user: user(userId) })),
  boards: [],
});

function clientRow(): Row {
  return {
    id: 'client-1',
    name: 'Acme',
    contacts: [],
    invoices: [],
    documents: [],
    contracts: [],
    projects: [project('p-mine', ['emp-1']), project('p-private', ['emp-2'])],
  };
}

const findUnique = vi.fn(async (args: Args) => shape(clientRow(), args));
const findMany = vi.fn(async (args: Args) => [shape(clientRow(), args)]);
const groupBy = vi.fn(async () => []);
const update = vi.fn();

function caller(userId: string, role: 'ADMIN' | 'EMPLOYEE') {
  return clientsRouter.createCaller({
    db: {
      client: { findUnique, findMany, update, delete: update },
      project: { update },
      invoice: { groupBy },
    },
    entitlements: { enabledModules: [] },
    session: {
      expires: 'later',
      user: {
        id: userId,
        organizationId: 'org-1',
        role,
        department: 'ENGINEERING',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const ids = (client: unknown) => ((client as { projects: Row[] }).projects ?? []).map((p) => p.id);

describe('clients router — linked project visibility (DEV-839)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getById shows a member of one linked project only that project', async () => {
    const client = await caller('emp-1', 'EMPLOYEE').getById({ id: 'client-1' });

    expect(ids(client)).toEqual(['p-mine']);
    expect(JSON.stringify(client)).not.toContain('p-private');
    expect(JSON.stringify(client)).not.toContain('EMP-2');
  });

  it('getById shows a non-member none of the linked projects', async () => {
    const client = await caller('emp-3', 'EMPLOYEE').getById({ id: 'client-1' });
    expect(ids(client)).toEqual([]);
  });

  it('getById never returns project budget, description or other detail', async () => {
    for (const [id, role] of [
      ['emp-1', 'EMPLOYEE'],
      ['admin-1', 'ADMIN'],
    ] as const) {
      const client = await caller(id, role).getById({ id: 'client-1' });
      for (const p of (client as unknown as { projects: Row[] }).projects) {
        expect(Object.keys(p).sort()).toEqual(['id', 'members', 'name', 'status']);
        for (const m of p.members as Row[]) {
          expect(Object.keys(m)).toEqual(['user']);
          expect(Object.keys(m.user as Row).sort()).toEqual(['avatar', 'id', 'name']);
        }
      }
    }
  });

  it('getById still shows an admin every linked project', async () => {
    const client = await caller('admin-1', 'ADMIN').getById({ id: 'client-1' });
    expect(ids(client)).toEqual(['p-mine', 'p-private']);
  });

  it('getAll counts only the caller’s projects for a non-admin, all for an admin', async () => {
    const [mine] = await caller('emp-1', 'EMPLOYEE').getAll();
    expect(mine._count.projects).toBe(1);

    const [outsider] = await caller('emp-3', 'EMPLOYEE').getAll();
    expect(outsider._count.projects).toBe(0);

    const [admin] = await caller('admin-1', 'ADMIN').getAll();
    expect(admin._count.projects).toBe(2);
  });

  it('a filtered read causes no writes', async () => {
    await caller('emp-1', 'EMPLOYEE').getById({ id: 'client-1' });
    await caller('emp-1', 'EMPLOYEE').getAll();
    expect(update).not.toHaveBeenCalled();
  });
});
