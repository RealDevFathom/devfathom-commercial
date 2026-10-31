import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async (..._args: unknown[]) => true),
  notify: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('@/lib/notifications', () => ({ notify: mocks.notify }));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://example.test',
  sendEmail: vi.fn(),
  templates: {
    leaveRequest: vi.fn(() => ({ subject: '', html: '', text: '' })),
    resignationDecision: vi.fn(() => ({ subject: '', html: '', text: '' })),
  },
}));
vi.mock('../audit', () => ({
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { resignationsRouter } from './resignations';
import { teamRouter } from './team';

const reviewer = {
  id: 'reviewer-1',
  name: 'Reviewer',
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
  organizationId: 'org-1',
};

function context(db: unknown): TRPCContext {
  return {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: [], modules: [] },
    session: { expires: 'later', user: reviewer },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

describe('atomic HR decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
  });

  it('uses a pending compare-and-swap for leave and emits no effect when it loses', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      userId: 'employee-1',
      status: 'PENDING',
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirstOrThrow = vi.fn();
    const tx = { leaveRequest: { updateMany, findFirstOrThrow } };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx));
    const caller = teamRouter.createCaller(
      context({ leaveRequest: { findFirst }, $transaction: transaction })
    );

    await expect(
      caller.updateLeaveStatus({ id: 'leave-1', status: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'leave-1', organizationId: 'org-1', status: 'PENDING' },
      data: { status: 'APPROVED', approvedById: reviewer.id },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'leave-1', organizationId: 'org-1' } })
    );
    expect(findFirstOrThrow).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('reports a conflict when the leave winner commits before the contender reads', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      userId: 'employee-1',
      status: 'REJECTED',
    });
    const transaction = vi.fn();
    const caller = teamRouter.createCaller(
      context({ leaveRequest: { findFirst }, $transaction: transaction })
    );

    await expect(
      caller.updateLeaveStatus({ id: 'leave-1', status: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(transaction).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('notifies only after the winning leave transaction commits', async () => {
    const leave = {
      id: 'leave-1',
      userId: 'employee-1',
      status: 'APPROVED',
      type: 'VACATION',
      startDate: new Date('2026-11-02'),
      endDate: new Date('2026-11-03'),
    };
    const findFirst = vi.fn().mockResolvedValue({
      userId: leave.userId,
      status: 'PENDING',
    });
    const tx = {
      leaveRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn().mockResolvedValue(leave),
      },
    };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => unknown) => {
      const result = await work(tx);
      expect(mocks.notify).not.toHaveBeenCalled();
      return result;
    });
    const caller = teamRouter.createCaller(
      context({ leaveRequest: { findFirst }, $transaction: transaction })
    );

    await expect(
      caller.updateLeaveStatus({ id: leave.id, status: 'APPROVED' })
    ).resolves.toBe(leave);

    expect(transaction).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('uses a pending compare-and-swap for resignation and emits no effect when it loses', async () => {
    const resignation = {
      id: 'resignation-1',
      userId: 'employee-1',
      status: 'PENDING',
      proposedLastDay: new Date('2026-01-01'),
      user: { id: 'employee-1', role: 'EMPLOYEE', name: 'Employee', email: 'e@example.test' },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirstOrThrow = vi.fn();
    const updateUser = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: resignation.id }]),
      resignation: {
        findFirst: vi.fn().mockResolvedValue(resignation),
        updateMany,
        findFirstOrThrow,
      },
      user: { update: updateUser },
    };
    const db = {
      $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)),
    };
    const caller = resignationsRouter.createCaller(context(db));

    await expect(caller.review({ id: resignation.id, decision: 'DECLINED' })).rejects.toMatchObject(
      { code: 'CONFLICT' }
    );

    expect(tx.$queryRaw).toHaveBeenCalledWith(expect.any(Array), resignation.id, 'org-1');
    expect(tx.resignation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: resignation.id, organizationId: 'org-1' } })
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: resignation.id, organizationId: 'org-1', status: 'PENDING' },
      })
    );
    expect(findFirstOrThrow).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('reports a conflict when a resignation winner commits before the lock is acquired', async () => {
    const resignation = {
      id: 'resignation-1',
      userId: 'employee-1',
      status: 'DECLINED',
      proposedLastDay: new Date('2026-01-01'),
      user: { id: 'employee-1', role: 'EMPLOYEE', name: 'Employee', email: 'e@example.test' },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: resignation.id }]),
      resignation: {
        findFirst: vi.fn().mockResolvedValue(resignation),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      user: { update: vi.fn() },
    };
    const caller = resignationsRouter.createCaller(
      context({
        $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)),
      })
    );

    await expect(
      caller.review({ id: resignation.id, decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(mocks.can.mock.calls.map((args) => args[1])).toEqual(['hr:access']);
    expect(tx.resignation.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('commits due-date deactivation in the same transaction as the winning approval', async () => {
    const lastWorkingDay = new Date('2020-01-01');
    const resignation = {
      id: 'resignation-1',
      userId: 'employee-1',
      status: 'PENDING',
      proposedLastDay: lastWorkingDay,
      user: { id: 'employee-1', role: 'EMPLOYEE', name: 'Employee', email: 'e@example.test' },
    };
    const decided = { ...resignation, status: 'APPROVED', lastWorkingDay, reviewNote: null };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: resignation.id }]),
      resignation: {
        findFirst: vi.fn().mockResolvedValue(resignation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn().mockResolvedValue(decided),
      },
      user: { update: vi.fn().mockResolvedValue({}) },
    };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx));
    const caller = resignationsRouter.createCaller(
      context({
        $transaction: transaction,
      })
    );

    await expect(caller.review({ id: resignation.id, decision: 'APPROVED' })).resolves.toBe(
      decided
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-1', id: resignation.userId } },
      data: { status: 'INACTIVE' },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('rechecks authorization after locking when the target role changed', async () => {
    let targetRole = 'EMPLOYEE';
    const resignation = {
      id: 'resignation-1',
      userId: 'employee-1',
      status: 'PENDING',
      proposedLastDay: new Date('2026-01-01'),
      user: { id: 'employee-1', name: 'Employee', email: 'e@example.test' },
    };
    mocks.can.mockImplementation(async (...args: unknown[]) => {
      if (args[1] !== 'resignation:review') return true;
      const resource = args[2] as { targetRole?: string };
      return resource.targetRole !== 'ADMIN';
    });
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        // Model a promotion which committed while the review was waiting for its lock.
        targetRole = 'ADMIN';
        return [{ id: resignation.id }];
      }),
      resignation: {
        findFirst: vi.fn().mockImplementation(async () => ({
          ...resignation,
          user: { ...resignation.user, role: targetRole },
        })),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      user: { update: vi.fn() },
    };
    const caller = resignationsRouter.createCaller(
      context({
        $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)),
      })
    );

    await expect(caller.review({ id: resignation.id, decision: 'APPROVED' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.resignation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: resignation.id, organizationId: 'org-1' } })
    );
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'resignation:review',
      expect.objectContaining({ targetRole: 'ADMIN' }),
      { source: 'TRPC', db: tx }
    );
    expect(tx.resignation.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
