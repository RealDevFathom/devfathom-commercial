import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
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

  it.each([
    [
      'tenant login',
      <LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />,
    ],
    ['shared-host login', <SharedLoginForm callbackUrl="/dashboard" />],
    ['platform login', <PlatformLoginForm />],
  ])('keeps the show-password toggle in the tab order on %s', (_name, form) => {
    render(form);

    expect(screen.getByRole('button', { name: 'Show password' })).toHaveProperty('tabIndex', 0);
  });
});
