import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LoginForm } from '@/app/login/login-form';
import { SharedLoginForm } from '@/app/login/shared-login-form';
import { PlatformLoginForm } from '@/app/platform/(auth)/login/platform-login-form';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  {
    name: 'tenant login',
    renderForm: () =>
      render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />),
    passwordLabel: 'Password',
  },
  {
    name: 'shared-host login',
    renderForm: () => render(<SharedLoginForm callbackUrl="/dashboard" />),
    passwordLabel: 'Password',
  },
  {
    name: 'platform login',
    renderForm: () => render(<PlatformLoginForm />),
    passwordLabel: 'Password',
  },
])('$name password visibility control', ({ renderForm, passwordLabel }) => {
  it('is keyboard-focusable and toggles visibility without changing the password', () => {
    renderForm();
    const password = screen.getByLabelText(passwordLabel) as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });

    fireEvent.change(password, { target: { value: 'correct horse battery staple' } });

    expect(toggle).not.toHaveAttribute('tabindex', '-1');
    expect(toggle.tabIndex).toBe(0);
    toggle.focus();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);

    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('correct horse battery staple');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));

    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveValue('correct horse battery staple');
  });
});
