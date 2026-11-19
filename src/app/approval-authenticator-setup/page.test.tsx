import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('./setup-form', () => ({
  ApprovalAuthenticatorSetupForm: () => <form aria-label="Start set-up" />,
}));

import ApprovalAuthenticatorSetupPage from './page';

const actor = (user: Record<string, unknown>) => ({ session: { user: { id: 'user_1', ...user } } });

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
    expect(screen.getByRole('form', { name: 'Start set-up' })).toBeTruthy();
  });
});
