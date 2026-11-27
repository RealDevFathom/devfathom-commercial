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

import { OPEN_ATTEMPT_STATUSES } from '@/lib/pharmacy/card-terminal/open-attempts';
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
          id: 'legacy-admin',
          name: 'Legacy admin',
          email: 'legacy@example.test',
          role: 'ADMIN',
          organizationRole: null,
        },
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
    pharmacyClinicalBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
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
  it('lists and separately revokes the clinical admission of a legacy administrator', async () => {
    const f = fixture();
    const grant = { id: 'clinical-1', userId: 'legacy-admin', branchId: 'branch-a' };
    f.db.pharmacyClinicalBranchAssignment.findMany.mockResolvedValue([
      { ...grant, user: { name: 'Legacy admin' } },
    ]);
    f.db.pharmacyClinicalBranchAssignment.findFirst.mockResolvedValue(grant);
    const full = { id: 'full-legacy', userId: grant.userId, branchId: grant.branchId };
    f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([full]);
    const list = await f.caller.list();
    expect(list.members.map((m) => m.id)).not.toContain('legacy-admin');
    expect(list.assignments).toContainEqual({
      ...grant,
      branchName: 'Counter A',
      userName: 'Legacy admin',
      clinicalOnly: true,
    });
    const input = { assignmentId: grant.id, clinicalOnly: true };
    f.context.session.user.id = grant.userId;
    await expect(f.caller.unassign(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Another administrator must change your branch access.',
    });
    expect(f.db.pharmacyClinicalBranchAssignment.update).not.toHaveBeenCalled();
    f.context.session.user.id = 'admin-1';
    await expect(f.caller.unassign(input)).resolves.toEqual({ id: grant.id });
    expect(f.db.pharmacyClinicalBranchAssignment.update).toHaveBeenCalledWith({
      where: { id: grant.id },
      data: { active: false },
    });
    expect(f.db.pharmacyBranchAssignment.update).not.toHaveBeenCalled();
    f.db.pharmacyClinicalBranchAssignment.findMany.mockResolvedValue([]);
    expect((await f.caller.list()).assignments).toEqual([
      { ...full, branchName: 'Counter A', userName: 'Legacy admin' },
    ]);
  });

  it('requires another administrator to change the acting member’s own branch access', async () => {
    const f = fixture();
    f.context.session.user.id = 'cashier-1';
    const refusal = {
      code: 'FORBIDDEN',
      message: 'Another administrator must change your branch access.',
    };
    await expect(
      f.caller.assign({ branchId: 'branch-a', userId: 'cashier-1' })
    ).rejects.toMatchObject(refusal);
    await expect(f.caller.unassign({ assignmentId: 'pba-1' })).rejects.toMatchObject(refusal);
    expect(f.db.pharmacyBranchAssignment.upsert).not.toHaveBeenCalled();
    expect(f.db.pharmacyBranchAssignment.update).not.toHaveBeenCalled();
  });

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

describe('branch cash mode', () => {
  function cashModeFixture(enabled = false) {
    const f = fixture();
    const branch = { id: 'branch-a', name: 'Counter A', cashShiftsEnabled: enabled };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const tx = {
      pharmacyBranch: { findFirst: vi.fn(async () => branch), updateMany },
      pharmacyCardTerminalAttempt: { count: vi.fn(async () => 0) },
      pharmacyDrawerSession: { count: vi.fn(async () => 0) },
      pharmacyCashShift: { count: vi.fn(async () => 0) },
      auditLog: { create },
      user: {
        findFirst: vi.fn(async () => ({
          id: 'admin-1',
          organizationId: 'org-a',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRole: { key: 'owner', isSystem: true, permissions: [] },
          permissionOverrides: [],
        })),
      },
      $queryRaw: vi.fn(async () => []),
    };
    Object.assign(f.db, { $transaction: (work: (db: typeof tx) => unknown) => work(tx) });
    return { ...f, tx, updateMany, create };
  }

  it('saves the chosen mode on the active branch and audits who changed it', async () => {
    const f = cashModeFixture();
    await expect(f.caller.setCashMode({ branchId: 'branch-a', enabled: true })).resolves.toEqual({
      enabled: true,
    });
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'branch-a', active: true, cashShiftsEnabled: false },
      data: { cashShiftsEnabled: true },
    });
    expect(f.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        organizationId: 'org-a',
        targetId: 'branch-a',
        changes: { cashShiftsEnabled: { before: false, after: true } },
      }),
    });
  });

  it.each([true, false])(
    'refuses to switch to shifts=%s during an open terminal payment',
    async (enabled) => {
      const f = cashModeFixture(!enabled);
      f.tx.pharmacyCardTerminalAttempt.count.mockResolvedValue(1);
      await expect(f.caller.setCashMode({ branchId: 'branch-a', enabled })).rejects.toMatchObject({
        code: 'CONFLICT',
        message:
          'A card payment at this branch is still being finished. Settle or resolve it, then change how the branch closes.',
      });
      expect(f.tx.pharmacyCardTerminalAttempt.count).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          status: { in: [...OPEN_ATTEMPT_STATUSES] },
        },
      });
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    }
  );

  it.each(['pharmacyDrawerSession', 'pharmacyCashShift'] as const)(
    'refuses an open %s before updating or auditing',
    async (model) => {
      const f = cashModeFixture();
      f.tx[model].count.mockResolvedValue(1);
      await expect(
        f.caller.setCashMode({ branchId: 'branch-a', enabled: true })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(f.tx[model].count).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', branchId: 'branch-a', status: 'OPEN' },
      });
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    }
  );

  it('hides modes from a non-owner and refuses a support session before writing', async () => {
    const f = cashModeFixture();
    await expect(f.caller.cashModes()).resolves.toBeNull();
    expect(f.db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    Object.assign(f.context.session.user, { isSupportSession: true });
    await expect(
      f.caller.setCashMode({ branchId: 'branch-a', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a repeat save idempotent, and refuses an administrator without owner authority', async () => {
    const f = cashModeFixture();
    await f.caller.setCashMode({ branchId: 'branch-a', enabled: false });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
    f.tx.user.findFirst.mockResolvedValueOnce({
      id: 'admin-1',
      organizationId: 'org-a',
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: { key: 'manager', isSystem: true, permissions: [] },
      permissionOverrides: [],
    });
    await expect(
      f.caller.setCashMode({ branchId: 'branch-a', enabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});
