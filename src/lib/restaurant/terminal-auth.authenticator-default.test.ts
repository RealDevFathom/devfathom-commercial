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
import {
  applyOperatorAttemptCharge,
  isOperatorAttemptCharge,
} from '@/lib/test-support/operator-attempt-charge';

/**
 * DEV-961: with the authenticator required (the default), restaurant terminals keep working
 * for staff with no web login, who cannot set up an app and keep their PIN; a member with a
 * web login who has not set up the app cannot approve at a terminal with a PIN, so the
 * terminal is no way around the forced set-up. Operator sign-in keeps the PIN for everyone.
 */

const now = new Date('2026-11-19T10:00:00.000Z');

function fakeDb(userId: string | null, required = true) {
  // The durable credential row: the attempt charge and the clear both move it.
  const credential = {
    id: 'cred',
    organizationId: 'org',
    deviceId: null,
    credentialHash: 'hash:4821',
    failedAttempts: 0,
    lockedUntil: null as Date | null,
    revokedAt: null,
  };
  return {
    credential,
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) =>
      isOperatorAttemptCharge(query) ? applyOperatorAttemptCharge(() => credential, values) : []
    ),
    organization: { findFirst: vi.fn(async () => ({ requireApprovalAuthenticator: required })) },
    approvalAuthenticator: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn() },
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
      findMany: vi.fn(async () => [{ ...credential }]),
      findUnique: vi.fn(async () => ({ ...credential })),
      update: vi.fn(async ({ data }: { data: Partial<typeof credential> }) =>
        Object.assign(credential, data)
      ),
    },
  };
}

const approve = (db: ReturnType<typeof fakeDb>, secret = '4821', type: 'PIN' | 'BADGE' = 'PIN') =>
  authenticateOperator(db as never, {
    staffProfileId: 'staff-approver',
    type,
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
    const accepted = fakeDb(null);
    await expect(approve(accepted)).resolves.toEqual({
      ok: true,
      credentialId: 'cred',
      staffProfileId: 'staff-approver',
    });
    // The same approval row as a code approval, with the method PIN and no web login.
    expect(accepted.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        action: 'restaurant.terminal.coAuthorize',
        metadata: expect.objectContaining({
          approvalMethod: 'PIN',
          approverRight: 'coauth:approve',
          requestedByStaffProfileId: 'staff-cashier',
        }),
      }),
    });
    const db = fakeDb(null);
    await expect(approve(db, '0000')).resolves.toEqual({ ok: false, reason: 'INVALID' });
    // DEV-1055: the strike is charged atomically before the check and is kept.
    expect(db.credential).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
  });

  it('refuses the PIN of a web member who has not set up the app, and strikes the lockout', async () => {
    const db = fakeDb('manager');
    await expect(approve(db)).resolves.toEqual({ ok: false, reason: 'INVALID' });
    // DEV-1055: the strike is charged atomically before the check and is kept.
    expect(db.credential).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
  });

  it('takes the web member’s PIN again once the owner turns the authenticator off', async () => {
    await expect(approve(fakeDb('manager', false))).resolves.toMatchObject({ ok: true });
  });

  // A badge is a permanent secret like a PIN, so it follows the PIN rules: it cannot get a web
  // member who must use the app past the forced set-up (the credential row here stands for
  // the badge: the fake hash matches the secret '4821').
  it('refuses the badge of a web member who must use the app, and strikes the lockout', async () => {
    const db = fakeDb('manager');
    await expect(approve(db, '4821', 'BADGE')).resolves.toEqual({ ok: false, reason: 'INVALID' });
    // DEV-1055: the strike is charged atomically before the check and is kept.
    expect(db.credential).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('keeps the badge for a terminal-only approver, and for everyone while the setting is off', async () => {
    for (const db of [fakeDb(null), fakeDb('manager', false)]) {
      await expect(approve(db, '4821', 'BADGE')).resolves.toMatchObject({ ok: true });
      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          description: 'Approved with a badge',
          metadata: expect.objectContaining({
            approvalMethod: 'BADGE',
            approverRight: 'coauth:approve',
          }),
        }),
      });
    }
    await expect(approve(fakeDb(null), '0000', 'BADGE')).resolves.toEqual({
      ok: false,
      reason: 'INVALID',
    });
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
