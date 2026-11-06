import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-739: `dayCloseAccess` is what the day-close screen and the rail ask before
// offering a close. It must name exactly the branches the close procedures admit, for
// every kind of user, or a screen would offer a close the server refuses (or hide one it
// allows). Each case below asks dayCloseAccess, then runs closePreview on every branch
// of a small world and compares the two answers. Eligibility follows the assigned-role
// policy: a system Owner, Owner / Operator, Manager or Administrator role, or a legacy
// ADMIN with no organization role; DENY wins; non-admins need an active assignment.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Caller = ReturnType<typeof app.createCaller>['pharmacySales'];
type Rule = { capability: string; effect: string };

const ACCESS_REFUSALS = [
  { code: 'FORBIDDEN', message: 'Day-close permission is required to reconcile and close a day.' },
  { code: 'FORBIDDEN', message: 'Branch is outside your scope.' },
  { code: 'BAD_REQUEST', message: 'That record is not in this workspace.' },
];

/** org-1 has two active branches and a closed one; org-2's branch is another tenant's. */
const BRANCHES = [
  { id: 'branch-main', name: 'Main', organizationId: 'org-1', active: true },
  { id: 'branch-airport', name: 'Airport', organizationId: 'org-1', active: true },
  { id: 'branch-closed', name: 'Closed', organizationId: 'org-1', active: false },
  { id: 'branch-other-tenant', name: 'Elsewhere', organizationId: 'org-2', active: true },
];
const ACTIVE_IN_ORG = ['branch-airport', 'branch-main']; // by name, as dayCloseAccess orders them

type Assignment = { branchId: string; active?: boolean; organizationId?: string };
type StoredRole = { key: string; isSystem?: boolean; rules?: Rule[] };
type Persona = {
  sessionRole: string;
  sessionOrganization?: string;
  stored: {
    role?: string;
    status?: string;
    organizationId?: string;
    /** The assigned organization role; null for a legacy ADMIN with none. */
    organizationRole?: StoredRole | null;
    overrides?: Rule[];
  } | null;
  assignments?: Assignment[];
};

const template = (key: string): Rule[] =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => ({
    capability,
    effect: 'ALLOW',
  }));
const deny = (capability: string): Rule[] => [{ capability, effect: 'DENY' }];
/** The shipped system role of this template key, with its grants. */
const systemRole = (key: string, extra: Rule[] = []): StoredRole => ({
  key,
  isSystem: true,
  rules: [...template(key), ...extra],
});

let db: ReturnType<typeof world>;

function world(persona: Persona) {
  const stored = persona.stored;
  const assigned = stored?.organizationRole;
  const row = stored && {
    role: stored.role ?? 'EMPLOYEE',
    status: stored.status ?? 'ACTIVE',
    organizationId: stored.organizationId ?? 'org-1',
    organizationRole: assigned
      ? {
          key: assigned.key,
          isSystem: assigned.isSystem ?? true,
          permissions: assigned.rules ?? [],
        }
      : null,
    permissionOverrides: stored.overrides ?? [],
  };
  const assignments = (persona.assignments ?? []).map((assignment) => ({
    userId: 'actor-1',
    active: true,
    organizationId: 'org-1',
    ...assignment,
  }));
  type AssignmentWhere = {
    organizationId: string;
    userId: string;
    branchId?: string;
    active: boolean;
    branch: { organizationId: string; active: boolean };
  };
  // The same predicate for the one-branch check and the listing, as PostgreSQL applies it.
  const matching = (where: AssignmentWhere) =>
    assignments.filter((assignment) => {
      const branch = BRANCHES.find((candidate) => candidate.id === assignment.branchId);
      return (
        assignment.organizationId === where.organizationId &&
        assignment.userId === where.userId &&
        (where.branchId === undefined || assignment.branchId === where.branchId) &&
        assignment.active === where.active &&
        branch?.organizationId === where.branch.organizationId &&
        branch?.active === where.branch.active
      );
    });
  const state = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(state)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    pharmacyBranch: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; active?: boolean; id?: { in: string[] } };
        }) =>
          BRANCHES.filter(
            (branch) =>
              branch.organizationId === where.organizationId &&
              (where.active === undefined || branch.active === where.active) &&
              (!where.id || where.id.in.includes(branch.id))
          )
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ id }) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async ({ where }: { where: AssignmentWhere }) => {
        const [match] = matching(where);
        return match ? { id: `assignment-${match.branchId}` } : null;
      }),
      // Ordered by branch name, then branch id, as dayCloseAccess asks.
      findMany: vi.fn(async ({ where }: { where: AssignmentWhere }) =>
        matching(where)
          .map(({ branchId }) => ({
            branchId,
            name: BRANCHES.find((branch) => branch.id === branchId)!.name,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.branchId.localeCompare(b.branchId))
          .map(({ branchId }) => ({ branchId }))
      ),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerSession: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue(row) },
  };
  return state;
}

function caller(persona: Persona, organizationId: string | null = 'org-1'): Caller {
  return app.createCaller({
    db,
    entitlements: organizationId
      ? { organizationId, enabledModules: ['pharmacy-counter'], modules: [] }
      : { enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'actor-1',
        role: persona.sessionRole,
        status: 'ACTIVE',
        organizationId: persona.sessionOrganization ?? 'org-1',
      },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

/** True when closePreview lets this persona past every access check on the branch. */
async function previewAdmits(persona: Persona, branchId: string): Promise<boolean> {
  db = world(persona);
  try {
    await caller(persona).closePreview({
      branchId,
      businessDate: new Date('2026-10-20T00:00:00.000Z'),
    });
  } catch (error) {
    if (ACCESS_REFUSALS.some((refusal) => expect.objectContaining(refusal).asymmetricMatch(error)))
      return false;
    // Past the gate, the settlement read may fail on this bare mock; access is what
    // is compared here, and an admitted preview always reaches its transaction.
  }
  expect(db.$transaction).toHaveBeenCalledOnce();
  return true;
}

async function dayCloseAccessFor(persona: Persona) {
  db = world(persona);
  const answer = await caller(persona).dayCloseAccess();
  // A read: it never opens the close transaction or touches the ledger.
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.$queryRaw).not.toHaveBeenCalled();
  expect(db.$executeRaw).not.toHaveBeenCalled();
  return answer;
}

const ASSIGNED_TO_MAIN: Assignment[] = [{ branchId: 'branch-main' }];
const manager = (extra: Partial<NonNullable<Persona['stored']>> = {}) => ({
  organizationRole: systemRole('manager'),
  ...extra,
});

const personas: Array<[string, Persona, string[]]> = [
  // Owners, administrators and managers close.
  [
    'a legacy ADMIN with no organization role, organization-wide',
    { sessionRole: 'ADMIN', stored: { role: 'ADMIN', organizationRole: null } },
    ACTIVE_IN_ORG,
  ],
  [
    'an ADMIN holding the system admin role, organization-wide',
    { sessionRole: 'ADMIN', stored: { role: 'ADMIN', organizationRole: { key: 'admin' } } },
    ACTIVE_IN_ORG,
  ],
  [
    'an ADMIN holding the bootstrap system administrator role, organization-wide',
    { sessionRole: 'ADMIN', stored: { role: 'ADMIN', organizationRole: { key: 'administrator' } } },
    ACTIVE_IN_ORG,
  ],
  [
    'a manager assigned to Main',
    { sessionRole: 'EMPLOYEE', stored: manager(), assignments: ASSIGNED_TO_MAIN },
    ['branch-main'],
  ],
  [
    'a manager assigned to Main and the closed branch',
    {
      sessionRole: 'EMPLOYEE',
      stored: manager(),
      assignments: [{ branchId: 'branch-main' }, { branchId: 'branch-closed' }],
    },
    ['branch-main'],
  ],
  [
    'an owner assigned to both active branches',
    {
      sessionRole: 'EMPLOYEE',
      stored: { organizationRole: systemRole('owner') },
      assignments: [{ branchId: 'branch-main' }, { branchId: 'branch-airport' }],
    },
    ACTIVE_IN_ORG,
  ],
  [
    'an ADMIN demoted to Manager, assigned to Airport',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'EMPLOYEE', organizationRole: systemRole('manager') },
      assignments: [{ branchId: 'branch-airport' }],
    },
    ['branch-airport'],
  ],
  [
    'an ON_LEAVE manager assigned to Main',
    {
      sessionRole: 'EMPLOYEE',
      stored: manager({ status: 'ON_LEAVE' }),
      assignments: ASSIGNED_TO_MAIN,
    },
    ['branch-main'],
  ],
  [
    'an ON_LEAVE legacy ADMIN, organization-wide',
    { sessionRole: 'ADMIN', stored: { role: 'ADMIN', status: 'ON_LEAVE', organizationRole: null } },
    ACTIVE_IN_ORG,
  ],
  // Everyone else is refused everywhere.
  [
    'a pharmacist on a custom role that grants pharmacy:close',
    {
      sessionRole: 'EMPLOYEE',
      stored: {
        organizationRole: {
          key: 'closing-pharmacist',
          isSystem: false,
          rules: [...template('pharmacist'), { capability: 'pharmacy:close', effect: 'ALLOW' }],
        },
      },
      assignments: ASSIGNED_TO_MAIN,
    },
    [],
  ],
  [
    'the system Pharmacist role with a pharmacy:close override',
    {
      sessionRole: 'EMPLOYEE',
      stored: {
        organizationRole: systemRole('pharmacist'),
        overrides: [{ capability: 'pharmacy:close', effect: 'ALLOW' }],
      },
      assignments: ASSIGNED_TO_MAIN,
    },
    [],
  ],
  [
    'an ADMIN holding a custom role keyed administrator (not a system role)',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationRole: { key: 'administrator', isSystem: false } },
    },
    [],
  ],
  [
    'an ADMIN holding the system Pharmacist role',
    { sessionRole: 'ADMIN', stored: { role: 'ADMIN', organizationRole: systemRole('pharmacist') } },
    [],
  ],
  ['a manager assigned to no branch', { sessionRole: 'EMPLOYEE', stored: manager() }, []],
  [
    'a manager whose only assignment is inactive',
    {
      sessionRole: 'EMPLOYEE',
      stored: manager(),
      assignments: [{ branchId: 'branch-main', active: false }],
    },
    [],
  ],
  [
    'a manager assigned only to the closed branch',
    { sessionRole: 'EMPLOYEE', stored: manager(), assignments: [{ branchId: 'branch-closed' }] },
    [],
  ],
  [
    'a manager assigned only to another tenant’s branch',
    {
      sessionRole: 'EMPLOYEE',
      stored: manager(),
      assignments: [{ branchId: 'branch-other-tenant', organizationId: 'org-2' }],
    },
    [],
  ],
  ...(['SUSPENDED', 'INACTIVE', 'INVITED'] as const).flatMap(
    (status) =>
      [
        [
          `a ${status} manager assigned to Main`,
          { sessionRole: 'EMPLOYEE', stored: manager({ status }), assignments: ASSIGNED_TO_MAIN },
          [],
        ],
        [
          `a legacy ADMIN whose stored row is ${status}`,
          { sessionRole: 'ADMIN', stored: { role: 'ADMIN', status, organizationRole: null } },
          [],
        ],
      ] as Array<[string, Persona, string[]]>
  ),
  [
    'an assigned manager with a user pharmacy:close DENY',
    {
      sessionRole: 'EMPLOYEE',
      stored: manager({ overrides: deny('pharmacy:close') }),
      assignments: ASSIGNED_TO_MAIN,
    },
    [],
  ],
  [
    'an assigned owner with a role * DENY',
    {
      sessionRole: 'EMPLOYEE',
      stored: { organizationRole: systemRole('owner', deny('*')) },
      assignments: ASSIGNED_TO_MAIN,
    },
    [],
  ],
  [
    'a legacy ADMIN with a user pharmacy:* DENY',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationRole: null, overrides: deny('pharmacy:*') },
    },
    [],
  ],
  [
    'an ADMIN whose system admin role DENYs pharmacy:close',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationRole: { key: 'admin', rules: deny('pharmacy:close') } },
    },
    [],
  ],
  [
    'an ADMIN whose stored row moved to another tenant',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationId: 'org-2', organizationRole: null },
    },
    [],
  ],
  ['an ADMIN whose stored row cannot be read', { sessionRole: 'ADMIN', stored: null }, []],
  [
    'an ADMIN demoted to a default pharmacist, assigned to Main',
    {
      sessionRole: 'ADMIN',
      stored: { role: 'EMPLOYEE', organizationRole: systemRole('pharmacist') },
      assignments: ASSIGNED_TO_MAIN,
    },
    [],
  ],
  [
    'an ADMIN of another tenant whose session reaches this workspace',
    {
      sessionRole: 'ADMIN',
      sessionOrganization: 'org-2',
      stored: { role: 'ADMIN', organizationId: 'org-2', organizationRole: null },
    },
    [],
  ],
  // Every shipped template, as its system role, assigned to Main: only the closing ones close.
  ...PHARMACY_ROLE_TEMPLATES.map(
    (role) =>
      [
        `the shipped ${role.key} system role, assigned to Main`,
        {
          sessionRole: 'EMPLOYEE',
          stored: { organizationRole: systemRole(role.key) },
          assignments: ASSIGNED_TO_MAIN,
        },
        ['manager', 'owner', 'owner-operator'].includes(role.key) ? ['branch-main'] : [],
      ] as [string, Persona, string[]]
  ),
];

describe('pharmacySales.dayCloseAccess (DEV-739)', () => {
  beforeEach(() => {
    db = world({ sessionRole: 'ADMIN', stored: { role: 'ADMIN', organizationRole: null } });
  });

  it.each(personas)(
    'names exactly the branches closePreview admits: %s',
    async (_label, persona, expected) => {
      const answer = await dayCloseAccessFor(persona);
      expect(answer).toEqual({
        userId: 'actor-1',
        organizationId: persona.sessionOrganization ?? 'org-1',
        allowed: expected.length > 0,
        branchIds: expected,
      });
      const admitted: string[] = [];
      for (const branch of BRANCHES)
        if (await previewAdmits(persona, branch.id)) admitted.push(branch.id);
      expect(admitted.sort()).toEqual([...expected].sort());
    }
  );

  it('answers a manager assigned to many branches in a fixed number of reads (no read per branch)', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      id: `branch-${String(index).padStart(2, '0')}`,
      name: `Branch ${String(index).padStart(2, '0')}`,
      organizationId: 'org-1',
      active: true,
    }));
    BRANCHES.push(...many);
    try {
      const answer = await dayCloseAccessFor({
        sessionRole: 'EMPLOYEE',
        stored: manager(),
        assignments: many.map(({ id }) => ({ branchId: id })),
      });
      expect(answer.branchIds).toEqual(many.map(({ id }) => id));
      // The identity read, can()'s rule read and the membership read; one assignment
      // listing; no per-branch reads.
      expect(db.user.findUnique.mock.calls.length).toBeLessThanOrEqual(3);
      expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledOnce();
      expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    } finally {
      BRANCHES.splice(BRANCHES.length - many.length, many.length);
    }
  });

  it('never reports another tenant’s branch, even organization-wide', async () => {
    const answer = await dayCloseAccessFor({
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationRole: null },
    });
    expect(answer.branchIds).not.toContain('branch-other-tenant');
    expect(answer.branchIds).not.toContain('branch-closed');
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', active: true } })
    );
  });

  it('offers nothing when the session and the workspace disagree', async () => {
    const persona: Persona = {
      sessionRole: 'ADMIN',
      stored: { role: 'ADMIN', organizationRole: null },
    };
    db = world(persona);
    const answer = await caller(persona, 'org-2').dayCloseAccess();
    expect(answer).toMatchObject({ allowed: false, branchIds: [] });
  });
});
