import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-913 — mutations whose request names no branch now tag the branch of the
// record they act on. The entry those mutations really write (the real tRPC
// audit middleware and recorder, written through `ctx.audit.db`) is read back
// through the real audit router: an administrator limited to one branch sees
// the entries of that branch and not another's; the owner sees both.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
// The pharmacist holds the capability; the authorization itself is tested elsewhere.
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { auditRouter } from './audit';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';
import { pharmacySafetyRouter } from './pharmacy-safety';

const ORG = 'org_p';
const mounted = router({
  audit: auditRouter,
  pharmacyDispensing: pharmacyDispensingRouter,
  pharmacySafety: pharmacySafetyRouter,
});

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capabilities: readonly string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));
const manager = allow(PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'manager')!.capabilities);

const PEOPLE: Record<
  string,
  { role: 'ADMIN' | 'EMPLOYEE'; roleKey: string; rules: Rule[]; branches: string[] }
> = {
  owner: { role: 'ADMIN', roleKey: 'admin', rules: allow(['*']), branches: [] },
  northAdmin: { role: 'ADMIN', roleKey: 'manager', rules: manager, branches: ['branch_north'] },
  pharmacist: { role: 'EMPLOYEE', roleKey: 'pharmacist', rules: [], branches: ['branch_north'] },
};

/** The records the mutations load, each at one branch. */
const SALE_LINES: Record<string, string> = {
  line_north: 'branch_north',
  line_south: 'branch_south',
};
const REVIEW_ITEMS: Record<string, string> = { review_south: 'line_south' };
const INCIDENTS: Record<string, string> = { incident_north: 'branch_north' };

type Row = Record<string, unknown> & { id: string; createdAt: Date };
type Where = Record<string, unknown> | undefined;

/** Enough of Prisma's `where` for the audit router's list query. */
function matches(row: Row, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Where[]).every((part) => matches(row, part));
    if (key === 'OR') return (value as Where[]).some((part) => matches(row, part));
    if (value && typeof value === 'object' && 'path' in value) {
      const { path, equals } = value as { path: string[]; equals: unknown };
      let current: unknown = row[key];
      for (const segment of path)
        current =
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined;
      return current === equals;
    }
    if (value && typeof value === 'object' && 'in' in value)
      return (value as { in: unknown[] }).in.includes(row[key]);
    if (value && typeof value === 'object') throw new Error(`Unsupported filter on ${key}`);
    return row[key] === value;
  });
}

let rows: Row[] = [];

function makeDb() {
  const member = (id: string) => {
    const person = PEOPLE[id];
    if (!person) return null;
    return {
      id,
      status: 'ACTIVE',
      role: person.role,
      organizationId: ORG,
      organizationRole: { key: person.roleKey, isSystem: true, permissions: person.rules },
      permissionOverrides: [],
    };
  };
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => member(where.id)),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => member(where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id }))
      ),
    },
    userPermissionOverride: { findMany: vi.fn(async () => []) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (PEOPLE[where.userId]?.branches ?? []).map((branchId) => ({ branchId }))
      ),
    },
    pharmacyBranch: {
      findMany: vi.fn(async () => [
        { id: 'branch_north', name: 'North', code: 'N' },
        { id: 'branch_south', name: 'South', code: 'S' },
      ]),
    },
    pharmacySaleLine: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        SALE_LINES[where.id] ? { branchId: SALE_LINES[where.id] } : null
      ),
    },
    pharmacyPharmacistReviewItem: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        REVIEW_ITEMS[where.id] ? { saleLineId: REVIEW_ITEMS[where.id] } : null
      ),
      create: vi.fn(async () => ({ id: 'review_new' })),
    },
    pharmacyPharmacistReviewDecision: { create: vi.fn(async () => ({ id: 'decision_1' })) },
    pharmacySubstitutionRecord: { create: vi.fn(async () => ({ id: 'substitution_1' })) },
    pharmacyRegisterIncident: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        INCIDENTS[where.id] ? { branchId: INCIDENTS[where.id] } : null
      ),
    },
    pharmacyRegisterIncidentApproval: { create: vi.fn(async () => ({ id: 'approval_1' })) },
    auditLog: {
      // The recorder's write: the row exactly as it would be stored.
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `audit_${rows.length + 1}`, createdAt: new Date() } as Row;
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where?: Where }) =>
        rows.filter((row) => matches(row, where)).reverse()
      ),
      groupBy: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
  };
}

let db = makeDb();

function caller(userId: string) {
  const person = PEOPLE[userId]!;
  return mounted.createCaller({
    db,
    entitlements: {
      organizationId: ORG,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-dispensing', 'pharmacy-safety', 'audit'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, name: userId, role: person.role, status: 'ACTIVE', organizationId: ORG },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    // Written through this client, as inside a tenant transaction, so the row is captured.
    audit: { detail: {}, db },
  } as unknown as TRPCContext);
}

const substitution = {
  prescribedPresentationId: 'prescribed',
  suppliedPresentationId: 'supplied',
  equivalenceBasis: 'Same ingredient, strength, form and route',
  patientCommunication: 'Explained to the patient, who agreed.',
  jurisdictionRuleRef: 'RX-04',
};

async function recordActions() {
  const pharmacist = caller('pharmacist');
  await pharmacist.pharmacyDispensing.recordSubstitution({
    prescriptionLineId: 'rx_line_north',
    saleLineId: 'line_north',
    ...substitution,
  });
  await pharmacist.pharmacyDispensing.enqueueReview({
    prescriptionLineId: 'rx_line_south',
    saleLineId: 'line_south',
  });
  await pharmacist.pharmacyDispensing.decideReview({
    reviewItemId: 'review_south',
    kind: 'VERIFY',
  });
  await pharmacist.pharmacySafety.approveRegisterIncident({
    incidentId: 'incident_north',
    reason: 'Count corrected after recount.',
  });
}

beforeEach(() => {
  rows = [];
  db = makeDb();
});

describe('DEV-913 newly branch-tagged pharmacy entries', () => {
  it('records the branch of the record each mutation acts on', async () => {
    await recordActions();
    expect(
      rows.map((row) => [row.action, (row.metadata as Record<string, unknown>).branchId])
    ).toEqual([
      ['pharmacyDispensing.recordSubstitution', 'branch_north'],
      ['pharmacyDispensing.enqueueReview', 'branch_south'],
      ['pharmacyDispensing.decideReview', 'branch_south'],
      ['pharmacySafety.approveRegisterIncident', 'branch_north'],
    ]);
    for (const row of rows) {
      expect(row.actorId).toBe('pharmacist');
      expect(row.outcome).toBe('SUCCESS');
    }
  });

  it('shows a branch-limited administrator his branch and not another', async () => {
    await recordActions();
    const page = await caller('northAdmin').audit.list({});
    expect(page.items.map((item) => [item.action, item.branchName]).sort()).toEqual([
      ['pharmacyDispensing.recordSubstitution', 'North'],
      ['pharmacySafety.approveRegisterIncident', 'North'],
    ]);
    const north = await caller('northAdmin').audit.list({ branchId: 'branch_north' });
    expect(north.items).toHaveLength(2);
    await expect(
      caller('northAdmin').audit.list({ branchId: 'branch_south' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows the owner every branch and filters by one', async () => {
    await recordActions();
    const all = await caller('owner').audit.list({});
    expect(all.items.filter((item) => item.action.startsWith('pharmacy'))).toHaveLength(4);
    const south = await caller('owner').audit.list({ branchId: 'branch_south' });
    expect(south.items.map((item) => item.action).sort()).toEqual([
      'pharmacyDispensing.decideReview',
      'pharmacyDispensing.enqueueReview',
    ]);
  });

  it('leaves the entry workspace-wide when the record has no branch', async () => {
    await caller('pharmacist').pharmacyDispensing.enqueueReview({
      prescriptionLineId: 'rx_line_x',
      saleLineId: 'line_unknown',
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as Record<string, unknown>).branchId).toBeUndefined();
    expect((await caller('northAdmin').audit.list({})).items).toEqual([]);
  });
});
