import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
import { annotateAudit } from '@/server/audit';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';
import type { TRPCContext } from '../trpc';

const model = () => ({
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 'new' }),
  update: vi.fn().mockResolvedValue({ id: 'link' }),
});
function fixture() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyBranchAssignment: model(),
    pharmacyBranch: model(),
    pharmacySupplier: model(),
    pharmacySupplierRelationship: model(),
    pharmacyPurchaseOrder: model(),
    pharmacySupplierActionLink: model(),
    pharmacySupplierSubmission: model(),
    pharmacySupplierSubmissionApproval: model(),
  };
  db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
  db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch' }]);
  db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch' });
  db.pharmacySupplier.findMany.mockResolvedValue([{ id: 'supplier' }]);
  db.pharmacySupplierActionLink.findFirst.mockResolvedValue({ id: 'link', branchId: 'branch' });
  const ctx = {
    db,
    session: { user: { id: 'actor', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org' } },
    entitlements: { organizationId: 'org', modules: [] },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: pharmacySupplierLinksRouter.createCaller(ctx) };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
const actions = {
  createRelationship: () =>
    f.caller.createRelationship({ branchId: 'branch', supplierId: 'supplier' }),
  issue: () =>
    f.caller.issue({
      branchId: 'branch',
      relationshipId: 'relationship',
      purchaseOrderId: 'order',
      expiresAt: new Date('2035-01-01'),
    }),
  revoke: () => f.caller.revoke({ linkId: 'link' }),
  recordManual: () =>
    f.caller.recordManual({
      branchId: 'branch',
      actionLinkId: 'link',
      kind: 'ACKNOWLEDGEMENT',
      source: 'PHONE',
      sourceEvidence: 'Called supplier',
      idempotencyKey: 'key',
      payload: {},
    }),
  approveProposal: () =>
    f.caller.approveProposal({ branchId: 'branch', submissionId: 'submission', approved: true }),
};
describe.each(Object.keys(actions) as (keyof typeof actions)[])(
  '%s procurement security',
  (name) => {
    it.each(['cashier', 'deny', 'inactive'] as const)(
      'rejects %s before accessing supplier records',
      async (mode) => {
        f.db.user.findUnique.mockResolvedValue(
          mode === 'inactive'
            ? null
            : {
                organizationRole: {
                  permissions: [
                    {
                      capability: mode === 'cashier' ? 'pharmacy.counter' : 'pharmacy:*',
                      effect: 'ALLOW',
                    },
                  ],
                },
                permissionOverrides:
                  mode === 'deny' ? [{ capability: 'pharmacy:procurement', effect: 'DENY' }] : [],
              }
        );
        await expect(actions[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
        expect(f.db.pharmacySupplierActionLink.findFirst).not.toHaveBeenCalled();
        for (const delegate of Object.values(f.db)) {
          if ('create' in delegate) expect(delegate.create).not.toHaveBeenCalled();
          if ('update' in delegate) expect(delegate.update).not.toHaveBeenCalled();
        }
        expect(f.db.user.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: 'actor' }) })
        );
      }
    );
    it('rejects a branch outside active assignments', async () => {
      f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      await expect(actions[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacySupplierRelationship.create).not.toHaveBeenCalled();
      expect(f.db.pharmacySupplierActionLink.update).not.toHaveBeenCalled();
      expect(f.db.pharmacySupplierSubmissionApproval.create).not.toHaveBeenCalled();
    });
    it('rejects an inactive or invisible branch despite an assignment', async () => {
      f.db.pharmacyBranch.findFirst.mockResolvedValue(null);
      await expect(actions[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const delegate of Object.values(f.db)) {
        if ('create' in delegate) expect(delegate.create).not.toHaveBeenCalled();
        if ('update' in delegate) expect(delegate.update).not.toHaveBeenCalled();
      }
    });
  }
);
it('creates a relationship only for the assigned tenant branch and tenant supplier', async () => {
  await expect(actions.createRelationship()).resolves.toEqual({ id: 'new' });
  expect(f.db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
    where: { organizationId: 'org', branchId: 'branch', userId: 'actor', active: true },
    select: { id: true },
  });
  expect(f.db.pharmacySupplierRelationship.create).toHaveBeenCalledWith({
    data: { organizationId: 'org', branchId: 'branch', supplierId: 'supplier' },
  });
});
it('does not create a relationship to another tenant supplier', async () => {
  f.db.pharmacySupplier.findMany.mockResolvedValue([]);
  await expect(actions.createRelationship()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.db.pharmacySupplierRelationship.create).not.toHaveBeenCalled();
});
it('revokes a link through its stored tenant and branch', async () => {
  await actions.revoke();
  expect(f.db.pharmacySupplierActionLink.findFirst).toHaveBeenCalledWith({
    where: { id: 'link', organizationId: 'org' },
    select: { id: true, branchId: true },
  });
  expect(f.db.pharmacySupplierActionLink.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'link', organizationId: 'org', branchId: 'branch' } })
  );
});
it('does not revoke an invisible tenant link', async () => {
  f.db.pharmacySupplierActionLink.findFirst.mockResolvedValue(null);
  await expect(actions.revoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.db.pharmacySupplierActionLink.update).not.toHaveBeenCalled();
});

it('issues a signed link for an assigned procurement actor and matching supplier order', async () => {
  vi.stubEnv('AUTH_SECRET', 'supplier-link-security-test-key');
  try {
    f.db.pharmacySupplierRelationship.findFirst.mockResolvedValue({ supplierId: 'supplier' });
    f.db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({ id: 'order', supplierId: 'supplier' });
    const result = await actions.issue();
    expect(result?.token).toEqual(expect.any(String));
    expect(f.db.pharmacySupplierActionLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org',
        branchId: 'branch',
        createdByUserId: 'actor',
        purchaseOrderId: 'order',
        supplierRelationshipId: 'relationship',
      }),
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('records manual evidence for the assigned branch', async () => {
  f.db.pharmacySupplierActionLink.findFirst.mockResolvedValue({
    id: 'link',
    organizationId: 'org',
    branchId: 'branch',
    purchaseOrder: { lines: [] },
  });
  await actions.recordManual();
  expect(f.db.pharmacySupplierSubmission.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      organizationId: 'org',
      branchId: 'branch',
      actionLinkId: 'link',
      source: 'PHONE',
    }),
  });
});

it('approves a proposal for the assigned tenant branch', async () => {
  f.db.pharmacySupplierSubmission.findFirst.mockResolvedValue({ id: 'submission' });
  await actions.approveProposal();
  expect(f.db.pharmacySupplierSubmissionApproval.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      organizationId: 'org',
      branchId: 'branch',
      actorUserId: 'actor',
      submissionId: 'submission',
      approved: true,
    }),
  });
});

it('rechecks current authorization when the same caller is reused', async () => {
  await actions.createRelationship();
  f.db.pharmacySupplierRelationship.create.mockClear();
  f.db.user.findUnique.mockResolvedValue(null);
  await expect(actions.createRelationship()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.db.pharmacySupplierRelationship.create).not.toHaveBeenCalled();
});

describe.each(Object.keys(actions) as (keyof typeof actions)[])('%s owner access', (name) => {
  it.each(['owner', 'admin'] as const)(
    'retains all-capability %s access without assignments',
    async (mode) => {
      vi.stubEnv('AUTH_SECRET', 'owner-supplier-fixture-signing-key');
      try {
        f.db.user.findUnique.mockResolvedValue({
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRole: {
            key: mode,
            isSystem: mode === 'owner',
            permissions: [{ capability: '*', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        });
        f.db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch' }]);
        f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
        f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
        f.db.pharmacySupplierRelationship.findFirst.mockResolvedValue({ supplierId: 'supplier' });
        f.db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
          id: 'order',
          supplierId: 'supplier',
        });
        f.db.pharmacySupplierActionLink.findFirst.mockResolvedValue({
          id: 'link',
          organizationId: 'org',
          branchId: 'branch',
          purchaseOrder: { lines: [] },
        });
        f.db.pharmacySupplierSubmission.findFirst.mockResolvedValue({ id: 'submission' });
        await expect(actions[name]()).resolves.toBeDefined();
        expect(f.db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
        expect(annotateAudit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            metadata: expect.objectContaining({
              reason: 'owner-procurement-access-without-branch-assignment',
            }),
          })
        );
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
});
