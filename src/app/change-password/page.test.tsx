import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: mocks.resolveTenantActor,
}));
vi.mock('./change-password-form', () => ({
  ChangePasswordForm: () => <form aria-label="Change password" />,
}));

import ChangePasswordPage from './page';

const actor = (mustChangePassword: boolean) => ({
  session: { user: { id: 'user_1', mustChangePassword } },
});

describe('change-password page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a signed-out visitor to login', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    await expect(ChangePasswordPage()).rejects.toThrow('REDIRECT /login');
  });

  it('sends a member who already changed their password to the workspace', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor(false));
    await expect(ChangePasswordPage()).rejects.toThrow('REDIRECT /dashboard');
  });

  it('renders the form when the temporary password is still in force', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor(true));
    const page = await ChangePasswordPage();
    expect(page).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
