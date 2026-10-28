import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), signIn: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

import { PlatformLoginForm } from '../platform/(auth)/login/platform-login-form';
import { LoginForm } from './login-form';
import { SharedLoginForm } from './shared-login-form';

describe('login password visibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'tenant login',
      <LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />,
    ],
    ['shared-host login', <SharedLoginForm callbackUrl="/dashboard" />],
    ['platform login', <PlatformLoginForm />],
  ])('provides an accessible password toggle on %s', (_name, form) => {
    render(form);

    const password = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });

    fireEvent.change(password, { target: { value: 'correct horse battery staple' } });

    expect(toggle).not.toHaveAttribute('tabindex');
    expect(toggle).toHaveProperty('tabIndex', 0);
    expect(toggle).toHaveProperty('type', 'button');
    expect(password).toHaveProperty('type', 'password');
    expect(password).toHaveProperty('value', 'correct horse battery staple');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide password' })).toBe(toggle);
    expect(password).toHaveProperty('type', 'text');
    expect(password).toHaveProperty('value', 'correct horse battery staple');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Show password' })).toBe(toggle);
    expect(password).toHaveProperty('type', 'password');
    expect(password).toHaveProperty('value', 'correct horse battery staple');
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});
