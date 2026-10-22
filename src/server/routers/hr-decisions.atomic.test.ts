import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  notify: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/notifications', () => ({ notify: mocks.notify }));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://example.test'),
  sendEmail: vi.fn(),
  templates: new Proxy({}, { get: () => vi.fn(() => ({ subject: '', html: '', text: '' })) }),
}));

import { router, type TRPCContext } from '../trpc';
import { resignationsRouter } from './resignations';
import { teamRouter } from './team';

const app = router({ team: teamRouter, resignations: resignationsRouter });
const session = {
  expires: 'later',
  user: { id: 'reviewer', role: 'HR', department: 'PEOPLE', status: 'ACTIVE' },
};

function caller(db: object) {
  return app.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
    session,
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('atomic HR decisions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a leave decision that loses the PENDING compare-and-swap without notifying', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = {
      leaveRequest: {
        findUnique: vi.fn(async () => ({ userId: 'employee', status: 'PENDING' })),
      },
      $transaction: vi.fn(async (run) =>
        run({ leaveRequest: { updateMany, findUniqueOrThrow: vi.fn() } })
      ),
    };

    await expect(
      caller(db).team.updateLeaveStatus({ id: 'leave-1', status: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'leave-1', status: 'PENDING' } })
    );
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('rejects a stale resignation decision before offboarding or decision effects', async () => {
    const userUpdate = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = {
      resignation: {
        findUnique: vi.fn(async () => ({
          id: 'resignation-1',
          userId: 'employee',
          status: 'PENDING',
          proposedLastDay: new Date('2026-01-01'),
          user: { id: 'employee', role: 'EMPLOYEE', name: 'Employee', email: 'e@example.test' },
        })),
      },
      $transaction: vi.fn(async (run) =>
        run({ resignation: { updateMany, findUniqueOrThrow: vi.fn() }, user: { update: userUpdate } })
      ),
    };

    await expect(
      caller(db).resignations.review({ id: 'resignation-1', decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'resignation-1', status: 'PENDING' } })
    );
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('couples a winning due resignation approval and offboarding in one transaction', async () => {
    const due = new Date('2026-01-01');
    const userUpdate = vi.fn(async () => ({}));
    const tx = {
      resignation: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'resignation-1',
          userId: 'employee',
          status: 'APPROVED',
          lastWorkingDay: due,
          reviewNote: null,
        })),
      },
      user: { update: userUpdate },
    };
    const db = {
      resignation: {
        findUnique: vi.fn(async () => ({
          id: 'resignation-1',
          userId: 'employee',
          status: 'PENDING',
          proposedLastDay: due,
          user: { id: 'employee', role: 'EMPLOYEE', name: 'Employee', email: 'e@example.test' },
        })),
      },
      $transaction: vi.fn(async (run) => run(tx)),
    };

    await caller(db).resignations.review({ id: 'resignation-1', decision: 'APPROVED' });

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'employee' },
      data: { status: 'INACTIVE' },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.annotateAudit).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});
