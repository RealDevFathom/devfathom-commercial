import { beforeEach, describe, expect, it, vi } from 'vitest';

// #979, PR J — staff supplier-link procedures: deny by default with
// `pharmacy:procurement`, and the branch boundary, through the REAL ABAC engine.

const mocks = vi.hoisted(() => ({
  issueSupplierActionLink: vi.fn(),
  recordManualSupplierEvidence: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/supplier-action-links', () => ({
  SupplierLinkError: class SupplierLinkError extends Error {},
  getSupplierActionPage: vi.fn(),
  submitSupplierEvidence: vi.fn(),
  uploadSupplierDocument: vi.fn(),
  issueSupplierActionLink: mocks.issueSupplierActionLink,
  recordManualSupplierEvidence: mocks.recordManualSupplierEvidence,
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';
import type { ProcedureMeta, TRPCContext } from '../trpc';

const PERMISSION = 'You do not have permission for this action.';
const OUTSIDE_BRANCH = 'Branch is outside your scope.';
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities;

const PEOPLE: Record<string, { role: 'ADMIN' | 'EMPLOYEE'; grants: readonly string[] }> = {
  cashier: { role: 'EMPLOYEE', grants: template('cashier') },
  pharmacist: { role: 'EMPLOYEE', grants: template('pharmacist') },
  buyer: { role: 'EMPLOYEE', grants: template('procurement') },
  owner: { role: 'ADMIN', grants: ['*'] },
};

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'created', ...data })),
    update: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'updated', ...data })),
  };
}

function makeDb() {
  return {
    user: model(),
    pharmacyBranch: model(),
    pharmacySupplier: model(),
    pharmacyBranchAssignment: model(),
    pharmacySupplierRelationship: model(),
    pharmacySupplierActionLink: model(),
    pharmacySupplierSubmission: model(),
    pharmacySupplierSubmissionApproval: model(),
  };
}
let db = makeDb();

function caller(userId: string) {
  const person = PEOPLE[userId]!;
  return pharmacySupplierLinksRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, role: person.role, status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
type Caller = ReturnType<typeof caller>;

const CALLS = {
  createRelationship: (c: Caller) =>
    c.createRelationship({ branchId: 'branch_a', supplierId: 'supplier_a' }),
  issue: (c: Caller) =>
    c.issue({
      branchId: 'branch_a',
      relationshipId: 'rel_a',
      purchaseOrderId: 'po_a',
      expiresAt: FUTURE,
    }),
  revoke: (c: Caller) => c.revoke({ linkId: 'link_a' }),
  recordManual: (c: Caller) =>
    c.recordManual({
      actionLinkId: 'link_a',
      branchId: 'branch_a',
      kind: 'ACKNOWLEDGEMENT',
      source: 'PHONE',
      sourceEvidence: 'Called the distributor',
      idempotencyKey: 'manual-1',
      payload: {},
    }),
  approveProposal: (c: Caller) =>
    c.approveProposal({ submissionId: 'sub_a', branchId: 'branch_a', approved: true }),
} satisfies Record<string, (c: Caller) => Promise<unknown>>;
const STAFF = Object.keys(CALLS) as (keyof typeof CALLS)[];

beforeEach(() => {
  db = makeDb();
  mocks.issueSupplierActionLink.mockReset().mockResolvedValue({ id: 'link_a', token: 't' });
  mocks.recordManualSupplierEvidence.mockReset().mockResolvedValue({ id: 'evidence_a' });
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const person = PEOPLE[where.id];
    return person
      ? {
          id: where.id,
          role: person.role,
          status: 'ACTIVE',
          organizationRole: {
            permissions: person.grants.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
          permissionOverrides: [],
        }
      : null;
  });
  db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
  db.pharmacySupplier.findMany.mockResolvedValue([{ id: 'supplier_a' }]);
  db.pharmacyBranchAssignment.findFirst.mockImplementation(
    async ({ where }: { where: { userId: string; branchId: string } }) =>
      where.userId === 'buyer' && where.branchId === 'branch_a' ? { id: 'asg' } : null
  );
  db.pharmacySupplierActionLink.findFirst.mockResolvedValue({
    id: 'link_a',
    branchId: 'branch_a',
  });
  db.pharmacySupplierSubmission.findFirst.mockResolvedValue({ id: 'sub_a' });
});

describe('supplier links deny by default (PR J)', () => {
  it('declares pharmacy:procurement on every staff procedure; the token routes stay public', () => {
    const procedures = (
      pharmacySupplierLinksRouter as unknown as {
        _def: { procedures: Record<string, { _def: { meta?: ProcedureMeta } }> };
      }
    )._def.procedures;
    for (const name of STAFF) {
      expect(procedures[name]!._def.meta?.capabilities, name).toEqual(['pharmacy:procurement']);
    }
    expect(Object.keys(procedures).sort()).toEqual([...STAFF, 'get', 'submit'].sort());
  });

  it.each(STAFF.flatMap((name) => ['cashier', 'pharmacist'].map((who) => [name, who] as const)))(
    'refuses %s to the %s before any read or write',
    async (name, who) => {
      await expect(CALLS[name](caller(who))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: PERMISSION,
      });
      for (const [table, delegate] of Object.entries(db)) {
        if (table === 'user') continue;
        for (const fn of Object.values(delegate)) expect(fn).not.toHaveBeenCalled();
      }
      expect(mocks.issueSupplierActionLink).not.toHaveBeenCalled();
      expect(mocks.recordManualSupplierEvidence).not.toHaveBeenCalled();
    }
  );

  it.each(STAFF)('lets the solo owner (tenant admin, no assignment) %s', async (name) => {
    await expect(CALLS[name](caller('owner'))).resolves.toBeDefined();
  });

  it.each(STAFF)('lets an assigned procurement member %s', async (name) => {
    await expect(CALLS[name](caller('buyer'))).resolves.toBeDefined();
  });

  it.each(STAFF)('refuses %s at a branch the member is not assigned to', async (name) => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(CALLS[name](caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(db.pharmacySupplierActionLink.update).not.toHaveBeenCalled();
    expect(db.pharmacySupplierRelationship.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplierSubmissionApproval.create).not.toHaveBeenCalled();
    expect(mocks.issueSupplierActionLink).not.toHaveBeenCalled();
    expect(mocks.recordManualSupplierEvidence).not.toHaveBeenCalled();
  });

  it("revoke checks the link's own branch, not a payload branch", async () => {
    db.pharmacySupplierActionLink.findFirst.mockResolvedValue({
      id: 'link_a',
      branchId: 'branch_b',
    });
    await expect(CALLS.revoke(caller('buyer'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE_BRANCH,
    });
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'branch_b' }) })
    );
    expect(db.pharmacySupplierActionLink.update).not.toHaveBeenCalled();
  });

  it('revoke refuses a link outside this workspace', async () => {
    db.pharmacySupplierActionLink.findFirst.mockResolvedValue(null);
    await expect(CALLS.revoke(caller('buyer'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.pharmacySupplierActionLink.update).not.toHaveBeenCalled();
  });
});
