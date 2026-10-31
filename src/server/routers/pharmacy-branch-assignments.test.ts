import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const audit = vi.hoisted(() => ({ annotateAudit: vi.fn() }));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    recordTrpcAudit: vi.fn(),
    annotateAudit: (
      ctx: Parameters<typeof actual.annotateAudit>[0],
      detail: Parameters<typeof actual.annotateAudit>[1]
    ) => {
      audit.annotateAudit(ctx, detail);
      actual.annotateAudit(ctx, detail);
    },
  };
});

import type { TRPCContext } from '../trpc';
import { pharmacyBranchAssignmentsRouter } from './pharmacy-branch-assignments';

const cashierRole = {
  key: 'cashier',
  name: 'Cashier',
  permissions: [
    { capability: 'pharmacy.counter', effect: 'ALLOW' },
    { capability: 'pharmacy:orders', effect: 'ALLOW' },
  ],
};

function fixture(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  const db = {
    pharmacyBranch: {
      findMany: vi.fn(async () => [{ id: 'branch-a', code: 'A', name: 'Counter A' }]),
      findFirst: vi.fn(async (args?: { where?: { id?: string } }) =>
        args?.where?.id === 'branch-a' ? { id: 'branch-a' } : null
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: cashierRole.permissions },
        permissionOverrides: [],
      })),
      findMany: vi.fn(async () => [
        {
          id: 'cashier-1',
          name: 'Amina',
          email: 'amina@example.test',
          organizationRole: cashierRole,
        },
        {
          id: 'stranger-1',
          name: 'Stranger',
          email: 'stranger@example.test',
          organizationRole: { key: 'waiter', name: 'Waiter', permissions: [] },
        },
      ]),
      findFirst: vi.fn(async (args?: { where?: { id?: string } }) => {
        if (args?.where?.id !== 'cashier-1') return null;
        return {
          id: 'cashier-1',
          name: 'Amina',
          email: 'amina@example.test',
          organizationRole: cashierRole,
        };
      }),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ id: 'pba-1', branchId: 'branch-a', userId: 'cashier-1' }]),
      findFirst: vi.fn(async (args?: { where?: { id?: string } }) =>
        args?.where?.id === 'pba-1'
          ? { id: 'pba-1', branchId: 'branch-a', userId: 'cashier-1' }
          : null
      ),
      upsert: vi.fn(async () => ({ id: 'pba-1' })),
      update: vi.fn(async () => ({ id: 'pba-1' })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'admin-1',
        role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    caller: pharmacyBranchAssignmentsRouter.createCaller(context as unknown as TRPCContext),
  };
}

beforeEach(() => {
  audit.annotateAudit.mockClear();
});

describe('pharmacy branch assignments', () => {
  it('lists active pharmacy members and their assignments', async () => {
    const f = fixture();
    await expect(f.caller.list()).resolves.toEqual({
      branches: [{ id: 'branch-a', code: 'A', name: 'Counter A' }],
      members: [
        { id: 'cashier-1', name: 'Amina', email: 'amina@example.test', roleName: 'Cashier' },
      ],
      assignments: [
        {
          id: 'pba-1',
          branchId: 'branch-a',
          userId: 'cashier-1',
          branchName: 'Counter A',
          userName: 'Amina',
        },
      ],
    });
  });

  it('assigns and unassigns inside the session organization and records the audit', async () => {
    const f = fixture();
    await expect(f.caller.assign({ branchId: 'branch-a', userId: 'cashier-1' })).resolves.toEqual({
      id: 'pba-1',
    });
    expect(f.db.pharmacyBranchAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_branchId_userId: {
            organizationId: 'org-a',
            branchId: 'branch-a',
            userId: 'cashier-1',
          },
        },
        update: { active: true },
      })
    );
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'PharmacyBranchAssignment',
        targetId: 'pba-1',
        metadata: { action: 'assign', branchId: 'branch-a', userId: 'cashier-1' },
      })
    );

    await expect(f.caller.unassign({ assignmentId: 'pba-1' })).resolves.toEqual({ id: 'pba-1' });
    expect(f.db.pharmacyBranchAssignment.update).toHaveBeenCalledWith({
      where: { id: 'pba-1' },
      data: { active: false },
    });
  });

  it('refuses another organization, a closed branch, and a member without a pharmacy role', async () => {
    const foreign = fixture();
    foreign.context.session.user.organizationId = 'org-b';
    await expect(
      foreign.caller.assign({ branchId: 'branch-a', userId: 'cashier-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(foreign.db.pharmacyBranchAssignment.upsert).not.toHaveBeenCalled();

    const closed = fixture();
    await expect(
      closed.caller.assign({ branchId: 'closed-branch', userId: 'cashier-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });

    const stranger = fixture();
    await expect(
      stranger.caller.assign({ branchId: 'branch-a', userId: 'stranger-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stranger.db.pharmacyBranchAssignment.upsert).not.toHaveBeenCalled();

    const missing = fixture();
    await expect(missing.caller.unassign({ assignmentId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a session that is not an administrator', async () => {
    const f = fixture('EMPLOYEE');
    await expect(f.caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
