import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-913 — the audit log in a pharmacy workspace: open to the owner and
// administrators without the optional module, refused to cashiers and
// pharmacists by the server, filterable by person and branch, and limited to
// their own branches for an administrator who is not the owner.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { isModuleGranted } from '@/lib/module-catalog';
import { auditRouter } from './audit';
import { router, type TRPCContext } from '../trpc';

// Mounted at `audit` exactly as the app router mounts it, so the module gate sees `audit.*`.
const mounted = router({ audit: auditRouter });

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type Person = {
  role: 'ADMIN' | 'EMPLOYEE';
  roleKey: string;
  isSystem: boolean;
  rules: Rule[];
  branches: string[];
};

const allow = (capabilities: readonly string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));
const template = (key: string) =>
  allow(PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities);

const PEOPLE: Record<string, Person> = {
  owner: { role: 'ADMIN', roleKey: 'admin', isSystem: true, rules: allow(['*']), branches: [] },
  branchAdmin: {
    role: 'ADMIN',
    roleKey: 'manager',
    isSystem: true,
    rules: template('manager'),
    branches: ['branch_north'],
  },
  cashier: {
    role: 'EMPLOYEE',
    roleKey: 'cashier',
    isSystem: true,
    rules: template('cashier'),
    branches: ['branch_north'],
  },
  pharmacist: {
    role: 'EMPLOYEE',
    roleKey: 'pharmacist',
    isSystem: true,
    rules: template('pharmacist'),
    branches: ['branch_north'],
  },
};

const ROW = {
  id: 'audit_1',
  organizationId: 'org_p',
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
  actorType: 'USER',
  actorId: 'cashier',
  actorName: 'Cashier One',
  actorEmail: null,
  actorRole: 'EMPLOYEE',
  source: 'TRPC',
  category: 'PHARMACYSALES',
  operation: 'UPDATE',
  action: 'pharmacySales.returnAndRefund',
  input: { saleId: 'sale_1', approval: { pin: '[REDACTED]' } },
  changes: null,
  result: null,
  metadata: {
    branchId: 'branch_north',
    refundApproval: { approvedByUserId: 'owner' },
  } as Record<string, unknown>,
  outcome: 'SUCCESS',
};

function makeDb() {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => member(where.id)),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => member(where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id === 'owner' ? 'Owner Person' : id }))
      ),
    },
    userPermissionOverride: { findMany: vi.fn(async () => []) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (PEOPLE[where.userId]?.branches ?? []).map((branchId) => ({ branchId }))
      ),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        [
          { id: 'branch_north', name: 'North', code: 'N' },
          { id: 'branch_south', name: 'South', code: 'S' },
        ].filter((branch) => !where.id || where.id.in.includes(branch.id))
      ),
    },
    auditLog: {
      findMany: vi.fn<(args: { where?: unknown }) => Promise<(typeof ROW)[]>>(async () => [ROW]),
      groupBy: vi.fn(async () => []),
      count: vi.fn<(args: { where?: unknown }) => Promise<number>>(async () => 0),
    },
  };
}

function member(id: string) {
  const person = PEOPLE[id];
  if (!person) return null;
  return {
    id,
    status: 'ACTIVE',
    role: person.role,
    organizationId: 'org_p',
    organizationRole: {
      key: person.roleKey,
      isSystem: person.isSystem,
      permissions: person.rules,
    },
    permissionOverrides: [],
  };
}

let db = makeDb();

/** A pharmacy workspace whose plan does NOT include the optional audit module. */
function caller(userId: string, vertical = 'PHARMACY', enabledModules: string[] = []) {
  const person = PEOPLE[userId]!;
  return mounted.createCaller({
    db,
    entitlements: {
      organizationId: 'org_p',
      vertical,
      // What resolveOrganizationEntitlements reports: audit is baseline for a pharmacy.
      enabledModules: isModuleGranted('audit', enabledModules, vertical as never)
        ? [...enabledModules, 'audit']
        : enabledModules,
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, role: person.role, status: 'ACTIVE', organizationId: 'org_p' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).audit;
}

function lastWhere() {
  return JSON.stringify(db.auditLog.findMany.mock.calls.at(-1)?.[0]?.where ?? null);
}

beforeEach(() => {
  db = makeDb();
});

describe('DEV-913 pharmacy audit log access', () => {
  it('opens for the owner of a pharmacy whose plan has no audit module', async () => {
    const page = await caller('owner').list({});
    expect(page.items).toHaveLength(1);
    // The owner reads every branch: no branch restriction on the query.
    expect(lastWhere()).not.toContain('branchId');
  });

  it.each(['cashier', 'pharmacist'])('refuses a %s on the server', async (userId) => {
    await expect(caller(userId).list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(userId).filters()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(userId).stats()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('keeps the module gate for other verticals', async () => {
    await expect(caller('owner', 'AGENCY').list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('owner', 'AGENCY', ['audit']).list({})).resolves.toBeDefined();
  });

  it('filters by person and by branch', async () => {
    await caller('owner').list({ actorId: 'cashier', branchId: 'branch_south' });
    const where = lastWhere();
    expect(where).toContain('"actorId":"cashier"');
    expect(where).toContain('"equals":"branch_south"');
    expect(where).toContain('"path":["branchId"]');
  });

  it('limits an administrator who is not the owner to their own branches', async () => {
    await caller('branchAdmin').list({});
    const where = lastWhere();
    expect(where).toContain('"equals":"branch_north"');
    expect(where).not.toContain('branch_south');

    await expect(caller('branchAdmin').list({ branchId: 'branch_south' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const filters = await caller('branchAdmin').filters();
    expect(filters.branches.map((branch) => branch.id)).toEqual(['branch_north']);
    await caller('branchAdmin').stats();
    for (const [args] of db.auditLog.count.mock.calls)
      expect(JSON.stringify(args)).toContain('branch_north');
  });

  it('lists every branch for the owner to filter by', async () => {
    const filters = await caller('owner').filters();
    expect(filters.branches.map((branch) => branch.name)).toEqual(['North', 'South']);
  });

  it('shows each entry with its branch and approver, and never the PIN', async () => {
    const [entry] = (await caller('owner').list({})).items;
    expect(entry).toMatchObject({
      branchId: 'branch_north',
      branchName: 'North',
      approvers: [{ id: 'owner', name: 'Owner Person' }],
    });
    expect(JSON.stringify(entry)).not.toMatch(/"pin":"\d/);
  });

  it('shows no approver when the manager PIN was refused', async () => {
    db.auditLog.findMany.mockResolvedValueOnce([
      {
        ...ROW,
        action: 'pharmacySales.returnLine',
        metadata: {
          branchId: 'branch_north',
          policy: 'PHARMACY_REFUND_MANAGER_PIN',
          approverId: 'owner',
          pinVerified: false,
        },
      },
    ]);
    const [entry] = (await caller('owner').list({})).items;
    expect(entry?.approvers).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('offers no way to change or remove an entry', () => {
    const procedures = Object.entries(auditRouter._def.procedures);
    expect(procedures.length).toBeGreaterThan(0);
    for (const [name, procedure] of procedures)
      expect((procedure as { _def: { type: string } })._def.type, name).toBe('query');
  });
});
