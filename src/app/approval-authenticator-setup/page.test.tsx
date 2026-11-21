import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  password: 'hash' as string | null,
  owner: false,
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, run: (db: unknown) => unknown) =>
    run({
      user: {
        findFirst: async () => ({
          password: mocks.password,
          id: 'user_1',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRole: mocks.owner
            ? { key: 'owner', isSystem: true, permissions: [] }
            : { key: 'manager', isSystem: false, permissions: [] },
          permissionOverrides: [],
        }),
      },
    }),
}));
vi.mock('./setup-form', () => ({
  ApprovalAuthenticatorSetupForm: ({
    passwordless,
    isOwner,
  }: {
    passwordless: boolean;
    isOwner: boolean;
  }) => (
    <form
      aria-label="Start set-up"
      data-passwordless={String(passwordless)}
      data-owner={String(isOwner)}
    />
  ),
}));

import ApprovalAuthenticatorSetupPage from './page';

const actor = (user: Record<string, unknown>) => ({
  session: { user: { id: 'user_1', ...user } },
  organization: { id: 'org_1' },
});

describe('DEV-961 approval authenticator set-up page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a signed-out visitor to login', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    await expect(ApprovalAuthenticatorSetupPage()).rejects.toThrow('REDIRECT /login');
  });

  it('changes a temporary password first', async () => {
    mocks.resolveTenantActor.mockResolvedValue(
      actor({ mustChangePassword: true, approvalAuthenticatorSetupRequired: true })
    );
    await expect(ApprovalAuthenticatorSetupPage()).rejects.toThrow('REDIRECT /change-password');
  });

  it('sends a member who is not asked (or is done) to the workspace', async () => {
    mocks.resolveTenantActor.mockResolvedValue(
      actor({ approvalAuthenticatorSetupRequired: false })
    );
    await expect(ApprovalAuthenticatorSetupPage()).rejects.toThrow('REDIRECT /dashboard');
  });

  it('renders the set-up for a member who must set up the app', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor({ approvalAuthenticatorSetupRequired: true }));
    render(await ApprovalAuthenticatorSetupPage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Set up your authenticator app' })
    ).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Start set-up' }).dataset.passwordless).toBe('false');
  });

  it('tells the form when the member has no password (single sign-on)', async () => {
    mocks.password = null;
    mocks.resolveTenantActor.mockResolvedValue(actor({ approvalAuthenticatorSetupRequired: true }));
    render(await ApprovalAuthenticatorSetupPage());
    expect(screen.getByRole('form', { name: 'Start set-up' }).dataset.passwordless).toBe('true');
    mocks.password = 'hash';
  });

  it('offers the permanent-PIN switch only to the owner', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor({ approvalAuthenticatorSetupRequired: true }));
    render(await ApprovalAuthenticatorSetupPage());
    expect(screen.getByRole('form', { name: 'Start set-up' }).dataset.owner).toBe('false');
  });

  it('tells the form when the member is the owner', async () => {
    mocks.owner = true;
    mocks.resolveTenantActor.mockResolvedValue(actor({ approvalAuthenticatorSetupRequired: true }));
    const { unmount } = render(await ApprovalAuthenticatorSetupPage());
    expect(screen.getByRole('form', { name: 'Start set-up' }).dataset.owner).toBe('true');
    unmount();
    mocks.owner = false;
  });
});
