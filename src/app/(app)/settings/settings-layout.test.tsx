import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'USER',
  vertical: 'PHARMACY',
  signIns: [] as { id: string; ip: string | null; userAgent: string | null; createdAt: string }[],
  profileSave: vi.fn(),
  passwordSave: vi.fn(),
}));
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
  useEntitlements: () => ({ vertical: mocks.vertical, modules: [], enabledModules: [] }),
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
                : path === 'team.mySignIns'
                  ? mocks.signIns
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
  mocks.vertical = 'PHARMACY';
  mocks.signIns = [];
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
    fireEvent.change(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Updated owner' } });
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    fireEvent.change(selectFieldControl(password), { target: { value: 'synthetic-unsaved-password' } });
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

it('hides the inapplicable navigation layout preference for pharmacy', () => {
  render(<SettingsContent />);
  expect(screen.queryByRole('radiogroup', { name: 'Navigation layout' })).not.toBeInTheDocument();
  expect(screen.queryByText('Side rail')).not.toBeInTheDocument();
  expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
});

it('preserves navigation preferences for other verticals', () => {
  mocks.vertical = 'AGENCY';
  render(<SettingsContent />);
  expect(screen.getByRole('radiogroup', { name: 'Navigation layout' })).toBeVisible();
});

it('shows recorded sign-in metadata and omits absent IP/device placeholders', () => {
  mocks.signIns = [
    {
      id: 'known',
      ip: '192.0.2.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
      createdAt: '2026-11-14T12:00:00Z',
    },
    { id: 'missing', ip: null, userAgent: null, createdAt: '2026-11-14T11:00:00Z' },
    { id: 'blank', ip: ' ', userAgent: ' ', createdAt: '2026-11-14T10:00:00Z' },
  ];
  render(<SettingsContent />);
  expect(screen.getByText('192.0.2.1')).toBeVisible();
  expect(screen.getByText('Chrome on Windows')).toBeVisible();
  expect(screen.queryByText(/Unknown IP|Unknown device/)).not.toBeInTheDocument();
  expect(screen.getAllByText('Successful sign-in')).toHaveLength(2);
});
