import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: 'USER', profileSave: vi.fn(), passwordSave: vi.fn() }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: { id: 'u', name: 'Pharmacy owner', email: 'owner@example.invalid', role: mocks.role },
    },
    status: 'authenticated',
  }),
  signOut: vi.fn(),
}));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/components/preferences-provider', () => ({
  usePreferences: () => ({
    density: 'comfortable',
    type: 'default',
    accent: 'default',
    layout: 'default',
    icons: 'default',
    setPreference: vi.fn(),
  }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'PHARMACY', modules: [], enabledModules: [] }),
}));
vi.mock('@/lib/trpc', () => {
  const endpoint = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useUtils') return () => endpoint();
        if (key === 'useQuery')
          return () => ({
            data:
              path === 'team.getById'
                ? { name: 'Pharmacy owner', skills: [], phone: null, bio: null }
                : undefined,
            isLoading: false,
            isError: false,
          });
        if (key === 'useMutation')
          return () => ({
            isPending: false,
            mutate:
              path === 'team.updateProfile'
                ? mocks.profileSave
                : path === 'team.changePassword'
                  ? mocks.passwordSave
                  : vi.fn(),
          });
        return endpoint(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: endpoint() };
});
import { SettingsContent } from './settings-content';

beforeEach(() => {
  mocks.role = 'USER';
  vi.clearAllMocks();
});
describe('the complete settings workspace', () => {
  it.each(['USER', 'ADMIN'])('uses a responsive, wider settings grid for %s', (role) => {
    mocks.role = role;
    const { container } = render(<SettingsContent />);
    const profile = screen.getByText('Profile', { exact: true }).closest('[data-slot="card"]');
    const password = screen.getByText('Password', { exact: true }).closest('[data-slot="card"]');
    const grid = profile?.parentElement;

    expect(container.firstElementChild).toHaveClass('w-full', 'max-w-[1400px]');
    expect(grid).toHaveClass('grid', 'grid-cols-1', 'items-start', 'gap-6', 'xl:grid-cols-2');
    expect(password?.parentElement).toBe(grid);
    expect(screen.queryByText('Notifications', { exact: true })).not.toBeInTheDocument();
  });

  it('preserves separate profile and password drafts while the sections share the workspace', () => {
    const { container } = render(<SettingsContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated owner' } });
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    fireEvent.change(password, { target: { value: 'synthetic-unsaved-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.profileSave).toHaveBeenCalledWith({
      name: 'Updated owner',
      phone: null,
      bio: null,
      skills: [],
    });
    expect(password.value).toBe('synthetic-unsaved-password');
    expect(mocks.passwordSave).not.toHaveBeenCalled();
    expect(screen.queryByText('API Tokens', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Webhooks', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Receipt designer and layout settings')).not.toBeInTheDocument();
  });
  it('keeps administrator sections and their entitlement refusals in the wider page', () => {
    mocks.role = 'ADMIN';
    render(<SettingsContent />);
    expect(screen.getByText('API Tokens', { exact: true })).toBeVisible();
    expect(screen.getByText('Webhooks', { exact: true })).toBeVisible();
    expect(screen.getAllByText(/currently unavailable for this organization/)).toHaveLength(2);
    expect(screen.queryByText('Receipt designer and layout settings')).not.toBeInTheDocument();
  });
});
