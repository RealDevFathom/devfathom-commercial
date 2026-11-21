import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  withTenantDb: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: mocks.resolveTenantActor,
  resolveTenantSessionDenial: vi.fn(),
  resolveTenantMismatchLoginPath: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: vi.fn() }));
vi.mock('@/lib/tenant-brand', () => ({ assertWorkspaceIdentity: vi.fn() }));
vi.mock('@/lib/demo/toolbar', () => ({ DemoToolbar: () => null }));
vi.mock('@/components/layout/app-shell', () => ({ AppShell: () => null }));
vi.mock('@/components/tenant-session-boundary', () => ({ TenantSessionBoundary: () => null }));

import AppLayout from './layout';

const actor = (user: Record<string, unknown>) => ({
  session: { user: { id: 'user_1', organizationId: 'org_1', status: 'ACTIVE', ...user } },
  organization: { id: 'org_1', isDemo: false },
  support: null,
});

describe('DEV-961 workspace pages while the approval authenticator is not set up', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a member who must set up the app to the set-up screen before any page renders', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor({ approvalAuthenticatorSetupRequired: true }));
    await expect(AppLayout({ children: null })).rejects.toThrow(
      'REDIRECT /approval-authenticator-setup'
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('changes a temporary password before the authenticator', async () => {
    mocks.resolveTenantActor.mockResolvedValue(
      actor({ mustChangePassword: true, approvalAuthenticatorSetupRequired: true })
    );
    await expect(AppLayout({ children: null })).rejects.toThrow('REDIRECT /change-password');
  });

  it('opens the workspace once set-up is done', async () => {
    mocks.resolveTenantActor.mockResolvedValue(
      actor({ approvalAuthenticatorSetupRequired: false })
    );
    mocks.withTenantDb.mockRejectedValue(new Error('workspace load reached'));
    await expect(AppLayout({ children: null })).rejects.toThrow('workspace load reached');
  });
});
