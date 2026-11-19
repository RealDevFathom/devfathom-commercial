import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutationOptions = {
  onSuccess?: (data: never) => void;
  onError?: (error: { message: string }) => void;
};
const mocks = vi.hoisted(() => ({
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, MutationOptions>,
  signOutEverything: vi.fn(),
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: mocks.signOutEverything }));
vi.mock('@/lib/trpc', () => {
  const endpoint = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useMutation')
          return (options: MutationOptions) => {
            mocks.options[path] = options;
            return { isPending: false, mutate: (mocks.mutations[path] ??= vi.fn()) };
          };
        return endpoint(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: endpoint() };
});

import { ApprovalAuthenticatorSetupForm } from './setup-form';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations = {};
  mocks.options = {};
});

describe('DEV-961 approval authenticator set-up form', () => {
  it('starts with the password, shows the QR code and key, confirms a code, then the recovery codes', () => {
    render(<ApprovalAuthenticatorSetupForm />);
    fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(mocks.mutations['approvalAuthenticator.beginEnrollment']).toHaveBeenCalledWith({
      currentPassword: 'pw',
    });
    act(() =>
      mocks.options['approvalAuthenticator.beginEnrollment'].onSuccess?.({
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      } as never)
    );
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    const check = screen.getByRole('button', {
      name: 'Check code and turn on',
    }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('6-digit code from your app'), {
      target: { value: '12x3456' },
    });
    fireEvent.click(check);
    expect(mocks.mutations['approvalAuthenticator.confirmEnrollment']).toHaveBeenCalledWith({
      token: '123456',
    });
    act(() =>
      mocks.options['approvalAuthenticator.confirmEnrollment'].onError?.({
        message: 'That code is incorrect. Try again.',
      })
    );
    expect(screen.getByRole('alert').textContent).toBe('That code is incorrect. Try again.');
    act(() =>
      mocks.options['approvalAuthenticator.confirmEnrollment'].onSuccess?.({
        enrolled: true,
        recoveryCodes: ['aaaaa-11111', 'bbbbb-22222'],
      } as never)
    );
    expect(screen.getByRole('list', { name: 'Recovery codes' }).textContent).toContain(
      'bbbbb-22222'
    );
    const go = screen.getByRole('button', {
      name: 'Continue to the workspace',
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('always offers sign-out', () => {
    render(<ApprovalAuthenticatorSetupForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.signOutEverything).toHaveBeenCalledWith('/login');
  });
});

describe('DEV-961 set-up form for a member with no password', () => {
  it('asks for no password and starts set-up on the fresh sign-in', () => {
    render(<ApprovalAuthenticatorSetupForm passwordless />);
    expect(screen.queryByLabelText('Your current password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(mocks.mutations['approvalAuthenticator.beginEnrollment']).toHaveBeenCalledWith({});
  });
});

describe('DEV-961 the owner may use permanent PINs instead', () => {
  it('offers the switch to the owner only, behind password and acknowledgement', () => {
    const { unmount } = render(<ApprovalAuthenticatorSetupForm />);
    expect(screen.queryByRole('button', { name: 'Use permanent PINs instead' })).toBeNull();
    unmount();

    render(<ApprovalAuthenticatorSetupForm isOwner />);
    fireEvent.click(screen.getByRole('button', { name: 'Use permanent PINs instead' }));
    expect(screen.getByText(/Anyone who sees or is told a PIN/)).toBeTruthy();
    const off = screen.getByRole('button', { name: 'Turn off and use PINs' }) as HTMLButtonElement;
    const passwords = screen.getAllByLabelText('Your current password');
    fireEvent.change(passwords[passwords.length - 1], { target: { value: 'owner pw' } });
    expect(off.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(off);
    expect(mocks.mutations['approvalAuthenticator.setRequired']).toHaveBeenCalledWith({
      required: false,
      currentPassword: 'owner pw',
      acknowledged: true,
    });
    act(() => mocks.options['approvalAuthenticator.setRequired'].onSuccess?.({} as never));
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
  });
});
