import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateApprover: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./terminal-auth', () => ({ withTerminalAuth: (handler: unknown) => handler }));
vi.mock('./terminal-orders', () => ({
  authenticateApprover: mocks.authenticateApprover,
  buildActor: vi.fn(),
  idempotencyKeyFromRequest: vi.fn(),
  invalidBody: vi.fn(),
  missingIdempotencyKey: vi.fn(),
  requireActingOperator: vi.fn(),
}));

import { operatorHasCapability, resolveApprover } from './checkout-routes';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TerminalContext } from './terminal-auth';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const BRANCH = 'branch_clifton';

/**
 * QA-145. Co-authorization must consult the restaurant SOP-1 job-role capabilities,
 * not just the linked `User` org-role permissions: a PIN-only floor manager who holds
 * the Owner job role (which carries `coauth:approve`) must be able to approve, while a
 * profile that neither path grants stays denied, and an organization it cannot see
 * (RLS-hidden) fails closed.
 */

type UserShape = {
  role?: string;
  organizationRole?: {
    key?: string;
    permissions: { capability: string; effect: 'ALLOW' | 'DENY' }[];
  } | null;
  permissionOverrides?: { capability: string; effect: 'ALLOW' | 'DENY' }[];
} | null;

function fakeDb(options: {
  user?: UserShape;
  /** Capabilities the held (active) job roles at this branch grant. */
  jobRoleCapabilities?: string[];
  /** Per-staff capability overrides at this branch. */
  overrides?: { capability: string; effect: 'ALLOW' | 'DENY' }[];
  /** When true, the profile is not visible (e.g. another org under RLS). */
  hidden?: boolean;
  status?: string;
  primaryBranchId?: string | null;
  jobRoleBranchIds?: string[];
  overrideBranchIds?: string[];
}): ScopedDb {
  const { user = null, jobRoleCapabilities = [], overrides = [], hidden = false } = options;
  return {
    restaurantStaffProfile: {
      findUnique: vi.fn(async () =>
        hidden
          ? null
          : {
              status: options.status ?? 'ACTIVE',
              primaryBranchId:
                options.primaryBranchId === undefined ? BRANCH : options.primaryBranchId,
              jobRoles: (options.jobRoleBranchIds ?? []).map((branchId) => ({ branchId })),
              directCapabilityGrants: (options.overrideBranchIds ?? []).map((branchId) => ({
                branchId,
              })),
              user: user
                ? {
                    role: user.role,
                    organizationRole: user.organizationRole ?? null,
                    permissionOverrides: user.permissionOverrides ?? [],
                  }
                : null,
            }
      ),
    },
    restaurantStaffJobRole: {
      findMany: vi.fn(async () =>
        hidden
          ? []
          : [
              {
                jobRole: {
                  capabilities: jobRoleCapabilities.map((capability) => ({ capability })),
                },
              },
            ]
      ),
    },
    restaurantStaffCapabilityGrant: {
      findMany: vi.fn(async () => (hidden ? [] : overrides)),
    },
  } as unknown as ScopedDb;
}

describe('operatorHasCapability — SOP-1 job-role path (QA-145)', () => {
  it.each(['owner', 'admin', 'owner-operator'])(
    'grants organization role key %s nothing beyond its permissions or branch binding',
    async (key) => {
      const unbound = fakeDb({
        primaryBranchId: 'another',
        user: { organizationRole: { key, permissions: [{ capability: '*', effect: 'ALLOW' }] } },
      });
      await expect(
        operatorHasCapability(unbound, 'staff', 'coauth:approve', NOW, BRANCH)
      ).resolves.toBe(false);
      const empty = fakeDb({ user: { organizationRole: { key, permissions: [] } } });
      await expect(
        operatorHasCapability(empty, 'staff', 'coauth:approve', NOW, BRANCH)
      ).resolves.toBe(false);
      await expect(
        operatorHasCapability(empty, 'staff', 'refund:issue', NOW, BRANCH)
      ).resolves.toBe(false);
    }
  );
  it('gives a tenant ADMIN no implicit branch access or money capability', async () => {
    const unbound = fakeDb({ primaryBranchId: null, user: { role: 'ADMIN' } });
    await expect(
      operatorHasCapability(unbound, 'staff', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(false);
    const bound = fakeDb({ user: { role: 'ADMIN' } });
    await expect(
      operatorHasCapability(bound, 'staff', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(false);
  });
  it('allows a PIN-only approver whose job role grants coauth:approve', async () => {
    const db = fakeDb({ user: null, jobRoleCapabilities: ['coauth:approve'] });
    await expect(
      operatorHasCapability(db, 'staff_floor_owner', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(true);
  });

  it('still allows via the linked user org-role (regression)', async () => {
    const db = fakeDb({
      user: {
        organizationRole: { permissions: [{ capability: 'coauth:approve', effect: 'ALLOW' }] },
      },
      jobRoleCapabilities: [],
    });
    await expect(
      operatorHasCapability(db, 'staff_linked', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(true);
  });

  it('denies when a per-staff DENY override removes an inherited capability', async () => {
    const db = fakeDb({
      user: null,
      jobRoleCapabilities: ['coauth:approve'],
      overrides: [{ capability: 'coauth:approve', effect: 'DENY' }],
    });
    await expect(
      operatorHasCapability(db, 'staff_denied', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(false);
  });

  it('denies when neither the linked user nor any job role grants the capability', async () => {
    const db = fakeDb({ user: null, jobRoleCapabilities: ['orders:take'] });
    await expect(
      operatorHasCapability(db, 'staff_cashier', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(false);
  });

  it('fails closed for a profile hidden by tenant isolation (another org)', async () => {
    const db = fakeDb({ hidden: true });
    await expect(
      operatorHasCapability(db, 'staff_other_org', 'coauth:approve', NOW, BRANCH)
    ).resolves.toBe(false);
  });

  it.each([undefined, '', '   '])(
    'denies missing or blank branch %s before querying',
    async (branch) => {
      const db = fakeDb({ user: { permissionOverrides: [{ capability: '*', effect: 'ALLOW' }] } });
      // Runtime callers must fail closed even if they bypass the required string type.
      await expect(
        operatorHasCapability(db, 'staff', 'coauth:approve', NOW, branch as string)
      ).resolves.toBe(false);
      expect(db.restaurantStaffProfile.findUnique).not.toHaveBeenCalled();
    }
  );

  it.each(['INACTIVE', 'ARCHIVED'])('denies %s staff despite grants', async (status) => {
    const db = fakeDb({ status, jobRoleCapabilities: ['coauth:approve'] });
    await expect(operatorHasCapability(db, 'staff', 'coauth:approve', NOW, BRANCH)).resolves.toBe(
      false
    );
    expect(db.restaurantStaffJobRole.findMany).not.toHaveBeenCalled();
  });

  it.each([null, 'other_branch'])(
    'denies unbound staff with primary branch %s despite grants',
    async (primaryBranchId) => {
      const db = fakeDb({ primaryBranchId, jobRoleCapabilities: ['coauth:approve'] });
      await expect(operatorHasCapability(db, 'staff', 'coauth:approve', NOW, BRANCH)).resolves.toBe(
        false
      );
    }
  );

  it.each(['jobRoleBranchIds', 'overrideBranchIds'] as const)(
    'accepts an explicit %s branch binding',
    async (binding) => {
      const db = fakeDb({
        primaryBranchId: null,
        [binding]: [BRANCH],
        jobRoleCapabilities: ['coauth:approve'],
      });
      await expect(operatorHasCapability(db, 'staff', 'coauth:approve', NOW, BRANCH)).resolves.toBe(
        true
      );
    }
  );

  it.each(['permissionOverrides', 'organizationRole'] as const)(
    'linked-user %s DENY beats job-role ALLOW',
    async (layer) => {
      const rules = [{ capability: 'coauth:*', effect: 'DENY' as const }];
      const db = fakeDb({
        user:
          layer === 'organizationRole'
            ? {
                organizationRole: { permissions: rules },
                permissionOverrides: [{ capability: '*', effect: 'ALLOW' }],
              }
            : { permissionOverrides: rules },
        jobRoleCapabilities: ['coauth:approve'],
      });
      await expect(operatorHasCapability(db, 'staff', 'coauth:approve', NOW, BRANCH)).resolves.toBe(
        false
      );
    }
  );

  it.each(['permissionOverrides', 'organizationRole'] as const)(
    'staff wildcard DENY beats linked-user %s ALLOW',
    async (layer) => {
      const rules = [{ capability: 'coauth:approve', effect: 'ALLOW' as const }];
      const db = fakeDb({
        user:
          layer === 'organizationRole'
            ? { organizationRole: { permissions: rules } }
            : { permissionOverrides: rules },
        jobRoleCapabilities: ['*'],
        overrides: [{ capability: 'coauth:*', effect: 'DENY' }],
      });
      await expect(operatorHasCapability(db, 'staff', 'coauth:approve', NOW, BRANCH)).resolves.toBe(
        false
      );
    }
  );
});

describe('resolveApprover — job-role approver (QA-145 repro)', () => {
  beforeEach(() => {
    mocks.authenticateApprover.mockReset();
  });

  function ctxWith(db: ScopedDb): TerminalContext {
    return {
      db,
      device: { id: 'device_1', branchId: BRANCH },
      session: { activeStaffProfileId: 'staff_acting' },
    } as unknown as TerminalContext;
  }

  it('accepts a PIN-only approver carrying coauth:approve through a job role', async () => {
    mocks.authenticateApprover.mockResolvedValue({
      ok: true,
      staffProfileId: 'staff_floor_owner',
    });
    const db = fakeDb({ user: null, jobRoleCapabilities: ['coauth:approve'] });
    const result = await resolveApprover(
      ctxWith(db),
      { staffProfileId: 'staff_floor_owner', type: 'PIN', secret: '1234' },
      NOW
    );
    expect(result).toEqual({ ok: true, staffProfileId: 'staff_floor_owner' });
  });

  it('rejects an authenticated approver who lacks coauth:approve everywhere', async () => {
    mocks.authenticateApprover.mockResolvedValue({
      ok: true,
      staffProfileId: 'staff_cashier',
    });
    const db = fakeDb({ user: null, jobRoleCapabilities: ['orders:take'] });
    const result = await resolveApprover(
      ctxWith(db),
      { staffProfileId: 'staff_cashier', type: 'PIN', secret: '1234' },
      NOW
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});
