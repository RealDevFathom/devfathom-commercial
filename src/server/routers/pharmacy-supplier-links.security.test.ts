import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SUPPLIER_LINK_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';
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
    pharmacyGoodsReceiptLine: model(),
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
  return {
    db,
    caller: pharmacySupplierLinksRouter.createCaller(ctx),
    publicCaller: pharmacySupplierLinksRouter.createCaller({ ...ctx, session: null }),
  };
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
    f.db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'order',
      supplierId: 'supplier',
      status: 'SENT',
    });
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

describe('supplier link expiry at issuance', () => {
  const issuedAt = new Date('2028-02-20T12:34:56.789Z');
  const order = { branchId: 'branch', relationshipId: 'relationship', purchaseOrderId: 'order' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(issuedAt);
    vi.stubEnv('AUTH_SECRET', 'synthetic-supplier-lifetime-fixture');
    f.db.pharmacySupplierRelationship.findFirst.mockResolvedValue({ supplierId: 'supplier' });
    f.db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'order',
      supplierId: 'supplier',
      status: 'SENT',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ['defaults to 14 days', undefined, '2028-03-05T12:34:56.789Z'],
    ['honors a shorter expiry', '2028-02-21T08:00:00Z', '2028-02-21T08:00:00Z'],
    ['accepts exactly 30 days', '2028-03-21T12:34:56.789Z', '2028-03-21T12:34:56.789Z'],
  ] as const)('%s', async (_name, requested, expected) => {
    const result = await f.caller.issue(
      requested ? { ...order, expiresAt: new Date(requested) } : order
    );
    expect(result.expiresAt).toEqual(new Date(expected));
    expect(f.db.pharmacySupplierActionLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ expiresAt: new Date(expected) }),
    });
  });

  it.each([
    ['at issuance', issuedAt],
    ['one millisecond over 30 days', new Date('2028-03-21T12:34:56.790Z')],
  ] as const)('refuses expiry %s without creating a link', async (_name, expiresAt) => {
    const outcome = await f.caller.issue({ ...order, expiresAt }).then(
      () => 'issued',
      (error) => error.code
    );
    expect(outcome).toBe('BAD_REQUEST');
    expect(f.db.pharmacySupplierActionLink.create).not.toHaveBeenCalled();
  });
});

it('explains a closed order only to the issuing buyer', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-closed-order-fixture');
  try {
    const order = { id: 'order', branchId: 'branch', supplierId: 'supplier', status: 'APPROVED' };
    const relationship = { branchId: 'branch', supplierId: 'supplier' };
    f.db.pharmacySupplierRelationship.findFirst.mockResolvedValue(relationship);
    f.db.pharmacyPurchaseOrder.findFirst.mockResolvedValue(order);
    const { token } = await actions.issue();

    order.status = 'CANCELLED';
    f.db.pharmacySupplierActionLink.findFirst.mockResolvedValue({
      id: 'link',
      organizationId: 'org',
      branchId: 'branch',
      relationship,
      purchaseOrder: order,
    });
    await expect(f.publicCaller.get({ token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: SUPPLIER_LINK_GENERIC_MESSAGE,
    });
    await expect(actions.issue()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Only approved, sent or receiving orders with items still to arrive can have a supplier link.',
    });
    expect(f.db.pharmacySupplierActionLink.create).toHaveBeenCalledTimes(1);
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
          status: 'APPROVED',
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
