import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'dummy-hash') }));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(
    async (_type: string, secret: string, hash: string) => hash === `hash:${secret}`
  ),
}));

import { authenticateOperator } from './terminal-auth';

/**
 * DEV-961: with the authenticator required (the default), restaurant terminals keep working
 * for staff with no web login, who cannot set up an app and keep their PIN; a member with a
 * web login who has not set up the app cannot approve at a terminal with a PIN, so the
 * terminal is no way around the forced set-up. Operator sign-in keeps the PIN for everyone.
 */

const now = new Date('2026-11-19T10:00:00.000Z');

function fakeDb(userId: string | null, required = true) {
  return {
    organization: { findFirst: vi.fn(async () => ({ requireApprovalAuthenticator: required })) },
    approvalAuthenticator: { findFirst: vi.fn(async () => null) },
    restaurantStaffProfile: {
      findUnique: vi.fn(async () => ({
        id: 'staff-approver',
        primaryBranchId: 'branch',
        status: 'ACTIVE',
        userId,
      })),
    },
    restaurantBranch: { findUnique: vi.fn() },
    restaurantOperatorCredential: {
      findMany: vi.fn(async () => [
        {
          id: 'cred',
          organizationId: 'org',
          deviceId: null,
          credentialHash: 'hash:4821',
          failedAttempts: 0,
          lockedUntil: null,
        },
      ]),
      update: vi.fn(),
    },
  };
}

const approve = (db: ReturnType<typeof fakeDb>, secret = '4821') =>
  authenticateOperator(db as never, {
    staffProfileId: 'staff-approver',
    type: 'PIN',
    secret,
    now,
    approval: {
      action: 'restaurant.terminal.coAuthorize',
      approverRight: 'coauth:approve',
      requestedByStaffProfileId: 'staff-cashier',
    },
  });

beforeEach(() => vi.clearAllMocks());

describe('DEV-961 restaurant terminal approvals with the authenticator on by default', () => {
  it('keeps a terminal-only approver (no web login) approving with the PIN', async () => {
    await expect(approve(fakeDb(null))).resolves.toEqual({
      ok: true,
      credentialId: 'cred',
      staffProfileId: 'staff-approver',
    });
    const db = fakeDb(null);
    await expect(approve(db, '0000')).resolves.toEqual({ ok: false, reason: 'INVALID' });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
  });

  it('refuses the PIN of a web member who has not set up the app, and strikes the lockout', async () => {
    const db = fakeDb('manager');
    await expect(approve(db)).resolves.toEqual({ ok: false, reason: 'INVALID' });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
  });

  it('takes the web member’s PIN again once the owner turns the authenticator off', async () => {
    await expect(approve(fakeDb('manager', false))).resolves.toMatchObject({ ok: true });
  });

  it('keeps operator sign-in (not an approval) on the PIN for everyone', async () => {
    await expect(
      authenticateOperator(fakeDb('manager') as never, {
        staffProfileId: 'staff-approver',
        type: 'PIN',
        secret: '4821',
        now,
      })
    ).resolves.toMatchObject({ ok: true });
  });
});
