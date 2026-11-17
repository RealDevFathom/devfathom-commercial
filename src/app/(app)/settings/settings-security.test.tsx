import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatorQrPath } from '@/components/ui/authenticator-qr';

type MutationOptions = {
  onSuccess?: (data: never) => void;
  onError?: (error: { message: string }) => void;
};
const mocks = vi.hoisted(() => ({
  role: 'USER',
  profileSave: vi.fn(),
  passwordSave: vi.fn(),
  signOut: vi.fn(),
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, MutationOptions>,
  pending: '' as string,
}));
vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: mocks.signOut }));
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
          return (options: MutationOptions) => {
            mocks.options[path] = options;
            return {
              isPending: mocks.pending === path,
              mutate:
                path === 'team.updateProfile'
                  ? mocks.profileSave
                  : path === 'team.changePassword'
                    ? mocks.passwordSave
                    : (mocks.mutations[path] ??= vi.fn()),
            };
          };
        return endpoint(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: endpoint() };
});
import { SettingsContent } from './settings-content';

import { passwordRules } from '@/lib/password-policy';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options = {};
  mocks.mutations = {};
  mocks.pending = '';
});

describe('DEV-48 settings security', () => {
  it('shows every shared password requirement before typing and keeps them after clearing', () => {
    render(<SettingsContent />);
    for (const rule of passwordRules) expect(screen.getByText(rule.label)).toBeVisible();
    const password = screen.getByLabelText('New Password');
    expect(password).toHaveAccessibleDescription(/At least 8 characters/);
    fireEvent.change(password, { target: { value: 'ValidPass1' } });
    expect(screen.getAllByText('Met:', { exact: false })).toHaveLength(passwordRules.length);
    fireEvent.change(password, { target: { value: '' } });
    for (const rule of passwordRules) expect(screen.getByText(rule.label)).toBeVisible();
  });

  it('keeps policy and matching-password checks before saving', () => {
    render(<SettingsContent />);
    fireEvent.change(screen.getByLabelText('Current Password'), {
      target: { value: 'CurrentPass1' },
    });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'weak' } });
    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: 'weak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(mocks.passwordSave).not.toHaveBeenCalled();
    expect(screen.getByText(/does not meet all the requirements/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'ValidPass1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(mocks.passwordSave).not.toHaveBeenCalled();
    expect(screen.getByText('Passwords do not match')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: 'ValidPass1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(mocks.passwordSave).toHaveBeenCalledWith({
      currentPassword: 'CurrentPass1',
      newPassword: 'ValidPass1',
    });
  });

  it('separates sign-out from routine actions and cancels without revoking sessions', async () => {
    render(<SettingsContent />);
    const danger = screen.getByRole('region', { name: 'Danger zone' });
    const trigger = within(danger).getByRole('button', { name: 'Sign out everywhere' });
    const passwordCard = screen
      .getByText('Password', { exact: true })
      .closest('[data-slot="card"]')!;
    expect(passwordCard).not.toContainElement(trigger);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' });
    expect(dialog).toHaveTextContent('including this device');
    expect(dialog).toHaveTextContent('Save any unfinished work');
    expect(mocks.mutations['team.signOutEverywhere']).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.mutations['team.signOutEverywhere']).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('requires confirmation, shows failures, and signs this device out only after success', async () => {
    const view = render(<SettingsContent />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(mocks.mutations['team.signOutEverywhere']).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).not.toHaveBeenCalled();
    mocks.pending = 'team.signOutEverywhere';
    view.rerender(<SettingsContent />);
    expect(within(dialog).getByRole('button', { name: 'Signing out…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    mocks.pending = '';
    act(() => mocks.options['team.signOutEverywhere'].onError?.({ message: 'Unable to connect.' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Unable to connect.');
    expect(mocks.signOut).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    act(() => mocks.options['team.signOutEverywhere'].onSuccess?.(undefined as never));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('explains manual authenticator setup, verification, and saving recovery codes', () => {
    render(<SettingsContent />);
    expect(screen.getByText(/along with your password/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Enable two-factor authentication' }));
    expect(mocks.mutations['twoFactor.beginEnrollment']).toHaveBeenCalledTimes(1);
    act(() =>
      mocks.options['twoFactor.beginEnrollment'].onSuccess?.({
        secret: 'SYNTHETICKEY',
        otpauthUri: 'otpauth://totp/test',
      } as never)
    );
    const steps = screen.getByRole('list', { name: 'Set up two-factor authentication' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(steps).toHaveTextContent('Google Authenticator');
    expect(steps).toHaveTextContent('Time based');
    expect(steps).toHaveTextContent('6-digit code');
    expect(screen.queryByText(/scan the URI/)).not.toBeInTheDocument();
    expect(screen.getByText('SYNTHETICKEY')).toBeVisible();
    expect(screen.getByText('Advanced setup link')).toBeVisible();
    // DEV-898: the setup link is also offered as a QR code to scan.
    const qr = screen.getByRole('img', { name: 'QR code to scan with your authenticator app' });
    expect(qr.querySelector('path')).toHaveAttribute(
      'd',
      authenticatorQrPath('otpauth://totp/test').path
    );
    expect(steps).toHaveTextContent('scanning the QR code');
    fireEvent.change(screen.getByLabelText('6-digit code from your app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & enable' }));
    expect(mocks.mutations['twoFactor.confirmEnrollment']).toHaveBeenCalledWith({
      token: '123456',
    });
    act(() =>
      mocks.options['twoFactor.confirmEnrollment'].onSuccess?.({
        recoveryCodes: ['SYNTHETIC-RECOVERY'],
      } as never)
    );
    expect(screen.getByText('Save your recovery codes')).toBeVisible();
    expect(screen.getByText(/Keep them somewhere safe/)).toBeVisible();
  });
});
