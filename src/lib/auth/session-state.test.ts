import { describe, expect, it } from 'vitest';

import {
  APPROVAL_AUTHENTICATOR_SETUP_PATH,
  ApprovalAuthenticatorSetupRequiredError,
  approvalAuthenticatorSetupBlocks,
  isApprovalAuthenticatorSetupApiExempt,
  workspaceRedirectForApprovalAuthenticator,
  ACCOUNT_INACTIVE_MESSAGE,
  SESSION_ENDED_MESSAGE,
  TEMPORARY_PASSWORD_MESSAGE,
  WORKSPACE_UNAVAILABLE_MESSAGE,
  evaluateSessionUser,
  isPasswordChangeApiExempt,
  isSessionUsable,
  liveDemoAccessExpiry,
  responseForPasswordChange,
  signInRedirectPath,
  temporaryPasswordBlocks,
  workspaceRedirectForPasswordChange,
  PasswordChangeRequiredError,
  type SessionUserState,
} from './session-state';

describe('liveDemoAccessExpiry', () => {
  it('accepts only a finite future numeric claim', () => {
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    expect(liveDemoAccessExpiry(now + 1, now)).toBe(now + 1);
    expect(liveDemoAccessExpiry(now, now)).toBeNull();
    expect(liveDemoAccessExpiry(Number.NaN, now)).toBeNull();
    expect(liveDemoAccessExpiry(Number.POSITIVE_INFINITY, now)).toBeNull();
    expect(liveDemoAccessExpiry(String(now + 1), now)).toBeNull();
  });
});

describe('evaluateSessionUser', () => {
  it.each([
    ['ACTIVE'],
    ['ON_LEAVE'], // #16 regression: on-leave staff keep their access.
  ])('admits an active session with status %s', (status) => {
    expect(evaluateSessionUser({ status, sessionRevoked: false })).toEqual({ ok: true });
  });

  it.each<[string, SessionUserState, string, string]>([
    // The revocation claim, in every reason it can carry.
    [
      'revoked session',
      { status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'REVOKED' },
      'session-ended',
      SESSION_ENDED_MESSAGE,
    ],
    [
      'deleted account',
      { status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'DELETED' },
      'session-ended',
      SESSION_ENDED_MESSAGE,
    ],
    [
      'failed revalidation',
      { status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'REVALIDATION_FAILED' },
      'session-ended',
      SESSION_ENDED_MESSAGE,
    ],
    [
      'suspended organization',
      { status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'ORGANIZATION_SUSPENDED' },
      'workspace-unavailable',
      WORKSPACE_UNAVAILABLE_MESSAGE,
    ],
    // Legacy sentinels written into `status` by tokens minted before #16.
    ['legacy REVOKED sentinel', { status: 'REVOKED' }, 'session-ended', SESSION_ENDED_MESSAGE],
    ['legacy DELETED sentinel', { status: 'DELETED' }, 'session-ended', SESSION_ENDED_MESSAGE],
    [
      'legacy REVALIDATION_FAILED sentinel',
      { status: 'REVALIDATION_FAILED' },
      'session-ended',
      SESSION_ENDED_MESSAGE,
    ],
    [
      'legacy ORGANIZATION_SUSPENDED sentinel',
      { status: 'ORGANIZATION_SUSPENDED' },
      'workspace-unavailable',
      WORKSPACE_UNAVAILABLE_MESSAGE,
    ],
    // Real account statuses that may not sign in.
    ['deactivated account', { status: 'INACTIVE' }, 'account-inactive', ACCOUNT_INACTIVE_MESSAGE],
    [
      'not-yet-onboarded account',
      { status: 'INVITED' },
      'account-inactive',
      ACCOUNT_INACTIVE_MESSAGE,
    ],
    ['unknown future status', { status: 'ARCHIVED' }, 'account-inactive', ACCOUNT_INACTIVE_MESSAGE],
  ])('rejects a %s', (_label, user, kind, message) => {
    const verdict = evaluateSessionUser(user);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe(kind);
    expect(verdict.message).toBe(message);
  });

  // The exact fail-open the QA report exercised: the old guard was
  // `if (user.status && ...)`, so a session with no status passed through.
  it.each<[string, SessionUserState | null | undefined]>([
    ['undefined status', { status: undefined }],
    ['null status', { status: null }],
    ['empty status', { status: '' }],
    ['no fields at all', {}],
    ['null user', null],
    ['undefined user', undefined],
  ])('fails closed on %s', (_label, user) => {
    const verdict = evaluateSessionUser(user);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe('session-ended');
    expect(verdict.message).toBe(SESSION_ENDED_MESSAGE);
  });

  it('never reports a revoked session as a deactivated account', () => {
    const verdict = evaluateSessionUser({
      status: 'ACTIVE',
      sessionRevoked: true,
      sessionInvalidReason: 'REVOKED',
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).not.toContain('administrator');
    expect(verdict.message).toBe('Your session has ended. Please sign in again.');
  });

  it('prefers the revocation claim over an otherwise-active status', () => {
    expect(isSessionUsable({ status: 'ACTIVE' })).toBe(true);
    expect(isSessionUsable({ status: 'ACTIVE', sessionRevoked: true })).toBe(false);
  });
});

describe('temporaryPasswordBlocks', () => {
  it('blocks every call except the password change while the flag is set', () => {
    expect(TEMPORARY_PASSWORD_MESSAGE).toBe('Change your temporary password before continuing.');
    expect(temporaryPasswordBlocks({ mustChangePassword: true }, 'team.updateProfile')).toBe(true);
    expect(
      temporaryPasswordBlocks({ mustChangePassword: true }, 'organizationAdmin.createMember')
    ).toBe(true);
    expect(temporaryPasswordBlocks({ mustChangePassword: true }, 'team.changePassword')).toBe(
      false
    );
    expect(temporaryPasswordBlocks({ mustChangePassword: true }, 'team.signOutEverywhere')).toBe(
      false
    );
    expect(temporaryPasswordBlocks({ mustChangePassword: false }, 'team.updateProfile')).toBe(
      false
    );
    expect(temporaryPasswordBlocks(undefined, 'team.updateProfile')).toBe(false);
  });
});

describe('password change gate', () => {
  it('redirects workspace pages and leaves the change-password screen to its own page', () => {
    expect(workspaceRedirectForPasswordChange(true)).toBe('/change-password');
    expect(workspaceRedirectForPasswordChange(false)).toBeNull();
    expect(workspaceRedirectForPasswordChange(undefined)).toBeNull();
  });

  it('exempts only the change-password and sign-out API calls', () => {
    const request = (path: string, method = 'POST') =>
      new Request(`https://tenant.test${path}`, { method });
    expect(isPasswordChangeApiExempt(request('/api/trpc/team.changePassword?batch=1'))).toBe(true);
    expect(isPasswordChangeApiExempt(request('/api/trpc/team.signOutEverywhere'))).toBe(true);
    expect(isPasswordChangeApiExempt(request('/api/auth/signout'))).toBe(true);
    expect(isPasswordChangeApiExempt(request('/api/login', 'DELETE'))).toBe(true);
    expect(isPasswordChangeApiExempt(request('/api/login', 'POST'))).toBe(false);
    expect(
      isPasswordChangeApiExempt(request('/api/trpc/team.changePassword,team.updateProfile'))
    ).toBe(false);
    expect(isPasswordChangeApiExempt(request('/api/upload'))).toBe(false);
  });

  it('answers the API with 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const response = responseForPasswordChange(new PasswordChangeRequiredError());
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      code: 'PASSWORD_CHANGE_REQUIRED',
      error: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(responseForPasswordChange(new Error('other'))).toBeNull();
  });
});

describe('signInRedirectPath', () => {
  it('sends every denial back to sign-in with its reason', () => {
    expect(signInRedirectPath('session-ended')).toBe('/login?reason=session-ended');
    expect(signInRedirectPath('account-inactive')).toBe('/login?reason=account-inactive');
    expect(signInRedirectPath('workspace-unavailable')).toBe('/login?reason=workspace-unavailable');
  });
});

describe('DEV-961 approval authenticator set-up gate', () => {
  const request = (path: string, method = 'POST') =>
    new Request(`https://tenant.test${path}`, { method });

  it('sends workspace pages to the set-up screen only while set-up is required', () => {
    expect(workspaceRedirectForApprovalAuthenticator(true)).toBe(APPROVAL_AUTHENTICATOR_SETUP_PATH);
    expect(workspaceRedirectForApprovalAuthenticator(false)).toBeNull();
    expect(workspaceRedirectForApprovalAuthenticator(undefined)).toBeNull();
  });

  it('lets only the set-up, password-change and sign-out procedures through', () => {
    const gated = { approvalAuthenticatorSetupRequired: true };
    for (const path of [
      'approvalAuthenticator.getStatus',
      'approvalAuthenticator.beginEnrollment',
      'approvalAuthenticator.confirmEnrollment',
      'approvalAuthenticator.setRequired',
      'team.changePassword',
      'team.signOutEverywhere',
    ])
      expect(approvalAuthenticatorSetupBlocks(gated, path)).toBe(false);
    for (const path of [
      'pharmacySales.refund',
      'approvalAuthenticator.members',
      'approvalAuthenticator.useRecoveryCode',
      'approvalAuthenticator.resetForMember',
      'team.updateProfile',
      '',
    ])
      expect(approvalAuthenticatorSetupBlocks(gated, path)).toBe(true);
    expect(
      approvalAuthenticatorSetupBlocks({ approvalAuthenticatorSetupRequired: false }, 'x')
    ).toBe(false);
    expect(approvalAuthenticatorSetupBlocks(undefined, 'x')).toBe(false);
  });

  it('exempts a tRPC batch only when every procedure in it is exempt', () => {
    expect(
      isApprovalAuthenticatorSetupApiExempt(
        request(
          '/api/trpc/approvalAuthenticator.getStatus,approvalAuthenticator.beginEnrollment?batch=1'
        )
      )
    ).toBe(true);
    for (const path of [
      '/api/trpc/approvalAuthenticator.getStatus,pharmacySales.refund?batch=1',
      '/api/trpc/approvalAuthenticator.getStatus%2CpharmacySales.refund?batch=1',
      '/api/trpc/pharmacySales.refund',
      '/api/trpc/',
      '/api/trpc/%E0%A4%A',
      '/api/upload',
      '/api/pharmacy/counter/sale',
      '/api/restaurant/terminal/co-authorize',
      '/api/v1/tasks',
    ])
      expect([path, isApprovalAuthenticatorSetupApiExempt(request(path))]).toEqual([path, false]);
    expect(isApprovalAuthenticatorSetupApiExempt(request('/api/auth/signout'))).toBe(true);
    expect(isApprovalAuthenticatorSetupApiExempt(request('/api/login', 'DELETE'))).toBe(true);
    expect(isApprovalAuthenticatorSetupApiExempt(request('/api/login', 'POST'))).toBe(false);
  });

  it('answers an API route with 403 APPROVAL_AUTHENTICATOR_SETUP_REQUIRED', async () => {
    const response = responseForPasswordChange(new ApprovalAuthenticatorSetupRequiredError());
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
    });
  });
});
