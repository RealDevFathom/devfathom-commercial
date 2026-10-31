import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    passwordReset: {
      validate: { useQuery: () => ({ data: { valid: true }, isLoading: false }) },
      reset: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
    invitations: {
      get: {
        useQuery: () => ({
          data: {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            title: 'Engineer',
            department: 'ENGINEERING',
            role: 'MEMBER',
          },
          isLoading: false,
          error: null,
        }),
      },
      accept: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
  },
}));

import { LoginForm } from './login-form';
import { SharedLoginForm } from './shared-login-form';
import { PlatformLoginForm } from '../platform/(auth)/login/platform-login-form';
import { ResetPasswordForm } from '../reset-password/[token]/reset-password-form';
import { AcceptInviteForm } from '../invite/[token]/accept-invite-form';

function expectAccessiblePasswordToggle(password: HTMLInputElement, confirmation?: HTMLInputElement) {
  const toggle = screen.getByRole('button', { name: 'Show password' });

  expect(toggle).not.toHaveAttribute('tabindex');
  expect(toggle).toHaveProperty('tabIndex', 0);
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  toggle.focus();
  expect(toggle).toHaveFocus();

  fireEvent.change(password, { target: { value: 'correct horse battery staple' } });
  if (confirmation) {
    fireEvent.change(confirmation, { target: { value: 'correct horse battery staple' } });
  }
  fireEvent.click(toggle);

  expect(password).toHaveAttribute('type', 'text');
  expect(password).toHaveValue('correct horse battery staple');
  expect(toggle).toHaveAccessibleName('Hide password');
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  if (confirmation) {
    expect(confirmation).toHaveAttribute('type', 'text');
    expect(confirmation).toHaveValue('correct horse battery staple');
  }

  fireEvent.click(toggle);
  expect(password).toHaveAttribute('type', 'password');
  expect(password).toHaveValue('correct horse battery staple');
  expect(toggle).toHaveAccessibleName('Show password');
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  if (confirmation) {
    expect(confirmation).toHaveAttribute('type', 'password');
    expect(confirmation).toHaveValue('correct horse battery staple');
  }
}

describe('password visibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enrollmentOnly: false })));
  });

  it('is keyboard reachable and toggles the tenant login password without changing it', () => {
    render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

    const password = screen.getByLabelText<HTMLInputElement>('Password');
    expect(password).toHaveAttribute('data-password-reveal');
    expectAccessiblePasswordToggle(password);
  });

  it('is keyboard reachable and toggles the shared-host login password without changing it', () => {
    render(<SharedLoginForm callbackUrl="/dashboard" />);

    const password = screen.getByLabelText<HTMLInputElement>('Password');
    expect(password).toHaveAttribute('data-password-reveal');
    expectAccessiblePasswordToggle(password);
  });

  it('is keyboard reachable and toggles the platform login password without changing it', () => {
    render(<PlatformLoginForm />);

    expectAccessiblePasswordToggle(screen.getByLabelText<HTMLInputElement>('Password'));
  });

  it('is keyboard reachable and toggles the reset password without changing it', () => {
    render(<ResetPasswordForm token="valid-token" />);

    const password = screen.getByLabelText<HTMLInputElement>('New Password');
    expect(password).toHaveAttribute('data-password-reveal');
    expect(password).toHaveAccessibleDescription(/At least 8 characters/);
    expectAccessiblePasswordToggle(
      password,
      screen.getByLabelText<HTMLInputElement>('Confirm Password')
    );
  });

  it('is keyboard reachable and toggles the invite password without changing it', () => {
    render(<AcceptInviteForm token="valid-token" />);

    const password = screen.getByLabelText<HTMLInputElement>('New Password *');
    expect(password).toHaveAttribute('data-password-reveal');
    expect(password).toHaveAccessibleDescription(/At least 8 characters/);
    expectAccessiblePasswordToggle(
      password,
      screen.getByLabelText<HTMLInputElement>('Confirm Password *')
    );
  });
});
