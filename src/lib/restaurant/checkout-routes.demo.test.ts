import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  compBody,
  refundBody,
  resolveApprover,
  resolveDemoApproverIdentity,
} from './checkout-routes';
import type { TerminalContext } from './terminal-auth';

const ORGANIZATION_ID = 'org_demo_restaurant_seat_1';
const NOW = new Date('2026-09-04T12:00:00.000Z');

function context(
  options: {
    actor?: 'valid' | 'missing' | 'expired' | 'wrong-org' | 'wrong-manager';
    demoOrganization?: boolean;
    approverId?: string | null;
  } = {}
) {
  const actorKind = options.actor ?? 'valid';
  const organization = {
    id: actorKind === 'wrong-org' ? 'org_demo_restaurant_seat_2' : ORGANIZATION_ID,
    slug: 'demo-restaurant-seat-1',
    displayName: 'Demo Restaurant — Seat 1',
    legalName: 'Demo Restaurant — Seat 1',
    status: 'ACTIVE',
    deploymentMode: 'SHARED',
    timezone: 'Asia/Karachi',
    locale: 'en-PK',
    currency: 'PKR',
    seatLimit: 5,
    isDemo: true,
  } as const;
  const demoActor =
    actorKind === 'missing'
      ? null
      : {
          support: null,
          organization,
          session: {
            expires: '2026-09-05T00:00:00.000Z',
            user: {
              id:
                actorKind === 'wrong-manager'
                  ? 'user_demo_restaurant_seat_1_other'
                  : 'user_demo_restaurant_seat_1_manager',
              email: 'manager.seat1@demo.devfathom.invalid',
              organizationId: ORGANIZATION_ID,
              demoAccessExpiresAt:
                actorKind === 'expired' ? NOW.getTime() - 1 : NOW.getTime() + 60_000,
            },
          },
        };
  const organizationFindFirst = vi.fn(async () =>
    options.demoOrganization === false ? null : { id: ORGANIZATION_ID }
  );
  const approverFindFirst = vi.fn(async () =>
    options.approverId === null
      ? null
      : { id: options.approverId ?? 'staff_demo_approver', displayName: 'Demo Approver' }
  );
  const approverFindUnique = vi.fn(async () => ({
    status: 'ACTIVE',
    primaryBranchId: 'branch_demo',
    jobRoles: [],
    directCapabilityGrants: [],
    user: {
      permissionOverrides: [],
      organizationRole: {
        permissions: [{ capability: 'coauth:approve', effect: 'ALLOW' }],
      },
    },
  }));
  const ctx = {
    organizationId: ORGANIZATION_ID,
    demoActor,
    db: {
      organization: { findFirst: organizationFindFirst },
      restaurantStaffJobRole: { findMany: vi.fn(async () => []) },
      restaurantStaffCapabilityGrant: { findMany: vi.fn(async () => []) },
      restaurantStaffProfile: {
        findFirst: approverFindFirst,
        findUnique: approverFindUnique,
      },
    },
    device: { id: 'device_demo', branchId: 'branch_demo' },
    session: { activeStaffProfileId: 'staff_acting' },
    state: 'UNLOCKED',
  } as unknown as TerminalContext;
  return { ctx, organizationFindFirst, approverFindFirst };
}

describe('demo refund approval transport', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'demo-approval-test-secret');
    mocks.authenticateApprover.mockReset();
    mocks.authenticateApprover.mockResolvedValue({
      ok: true,
      staffProfileId: 'staff_demo_approver',
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('adds DEMO only to refunds while preserving ordinary PIN and BADGE schemas', () => {
    const common = {
      originalTenderId: 'tender_1',
      amount: '10.00',
      reason: 'Guest request',
    };
    for (const type of ['PIN', 'BADGE'] as const) {
      expect(
        refundBody.safeParse({
          ...common,
          approving: { staffProfileId: 'staff_manager', type, secret: '1234' },
        }).success
      ).toBe(true);
    }
    expect(
      refundBody.safeParse({
        ...common,
        approving: { staffProfileId: 'staff_demo_approver', type: 'DEMO' },
      }).success
    ).toBe(true);
    expect(
      refundBody.safeParse({
        ...common,
        approving: { staffProfileId: 'staff_demo_approver', type: 'DEMO', secret: '1234' },
      }).success
    ).toBe(false);
    expect(
      compBody.safeParse({
        billId: 'bill_1',
        billLineId: 'line_1',
        reason: 'Comp',
        approving: { staffProfileId: 'staff_demo_approver', type: 'DEMO' },
      }).success
    ).toBe(false);
  });

  it.each([
    ['non-demo organization', { demoOrganization: false }],
    ['missing actor', { actor: 'missing' as const }],
    ['expired actor', { actor: 'expired' as const }],
    ['wrong organization actor', { actor: 'wrong-org' as const }],
    ['wrong manager actor', { actor: 'wrong-manager' as const }],
  ])('rejects DEMO approval for a %s', async (_label, options) => {
    const { ctx } = context(options);
    const result = await resolveApprover(
      ctx,
      { staffProfileId: 'staff_demo_approver', type: 'DEMO' },
      NOW
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(mocks.authenticateApprover).not.toHaveBeenCalled();
  });

  it('requires the exact active branch approver and keeps self-approval blocked', async () => {
    const { ctx, approverFindFirst } = context({ approverId: 'staff_acting' });
    const result = await resolveApprover(
      ctx,
      { staffProfileId: 'staff_acting', type: 'DEMO' },
      NOW
    );

    expect(result.ok).toBe(false);
    expect(mocks.authenticateApprover).not.toHaveBeenCalled();
    expect(approverFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        email: 'approver.seat1@demo.devfathom.invalid',
        status: 'ACTIVE',
        primaryBranchId: 'branch_demo',
        user: { status: 'ACTIVE', organizationId: ORGANIZATION_ID },
      },
      select: { id: true, displayName: true },
      orderBy: { id: 'asc' },
    });
  });

  it('returns only the designated public approver identity for a live demo actor', async () => {
    const { ctx } = context();

    await expect(resolveDemoApproverIdentity(ctx, NOW)).resolves.toEqual({
      staffProfileId: 'staff_demo_approver',
      displayName: 'Demo Approver',
      expiresAt: NOW.getTime() + 60_000,
    });
  });

  it('rejects a different selected manager even when the designated approver is valid', async () => {
    const { ctx } = context();
    const result = await resolveApprover(
      ctx,
      { staffProfileId: 'staff_alphabetically_first', type: 'DEMO' },
      NOW
    );

    expect(result.ok).toBe(false);
    expect(mocks.authenticateApprover).not.toHaveBeenCalled();
  });

  it('derives the server credential, then uses the normal resolver and capability gate', async () => {
    const { ctx } = context();
    const result = await resolveApprover(
      ctx,
      { staffProfileId: 'staff_demo_approver', type: 'DEMO' },
      NOW
    );

    expect(result).toEqual({ ok: true, staffProfileId: 'staff_demo_approver' });
    expect(mocks.authenticateApprover).toHaveBeenCalledTimes(1);
    const call = mocks.authenticateApprover.mock.calls[0];
    const credential = call[3] as { staffProfileId: string; type: string; secret: string };
    expect(call[1]).toBe('device_demo');
    expect(call[2]).toBe('branch_demo');
    expect(credential.staffProfileId).toBe('staff_demo_approver');
    expect(credential.type).toBe('PIN');
    expect(credential.secret.length).toBe(8);
    expect([...credential.secret].every((character) => character >= '0' && character <= '9')).toBe(
      true
    );
  });
});
