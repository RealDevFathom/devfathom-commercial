import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
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
    const findUnique = vi.fn().mockResolvedValue({
      userId: 'employee-1',
      status: 'PENDING',
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUniqueOrThrow = vi.fn();
    const tx = { leaveRequest: { updateMany, findUniqueOrThrow } };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx));
    const caller = teamRouter.createCaller(
      context({ leaveRequest: { findUnique }, $transaction: transaction })
    );

    await expect(
      caller.updateLeaveStatus({ id: 'leave-1', status: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'leave-1', status: 'PENDING' },
      data: { status: 'APPROVED', approvedById: reviewer.id },
    });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
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
    const findUniqueOrThrow = vi.fn();
    const updateUser = vi.fn();
    const tx = {
      resignation: { updateMany, findUniqueOrThrow },
      user: { update: updateUser },
    };
    const db = {
      resignation: { findUnique: vi.fn().mockResolvedValue(resignation) },
      $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)),
    };
    const caller = resignationsRouter.createCaller(context(db));

    await expect(
      caller.review({ id: resignation.id, decision: 'DECLINED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: resignation.id, status: 'PENDING' } })
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
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
      resignation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(decided),
      },
      user: { update: vi.fn().mockResolvedValue({}) },
    };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx));
    const caller = resignationsRouter.createCaller(
      context({
        resignation: { findUnique: vi.fn().mockResolvedValue(resignation) },
        $transaction: transaction,
      })
    );

    await expect(caller.review({ id: resignation.id, decision: 'APPROVED' })).resolves.toBe(
      decided
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: resignation.userId },
      data: { status: 'INACTIVE' },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});
