import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

import { LoginForm } from './login-form';
import { PlatformLoginForm } from '../platform/(auth)/login/platform-login-form';

function expectAccessiblePasswordToggle(password: HTMLInputElement) {
  const toggle = screen.getByRole('button', { name: 'Show password' });

  expect(toggle).not.toHaveAttribute('tabindex', '-1');
  toggle.focus();
  expect(toggle).toHaveFocus();

  fireEvent.change(password, { target: { value: 'correct horse battery staple' } });
  fireEvent.click(toggle);

  expect(password).toHaveAttribute('type', 'text');
  expect(password).toHaveValue('correct horse battery staple');
  expect(toggle).toHaveAccessibleName('Hide password');
  expect(toggle).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(toggle);
  expect(password).toHaveAttribute('type', 'password');
  expect(password).toHaveValue('correct horse battery staple');
  expect(toggle).toHaveAccessibleName('Show password');
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

describe('password visibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enrollmentOnly: false })));
  });

  it('is keyboard reachable and toggles the tenant login password without changing it', () => {
    render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

    expectAccessiblePasswordToggle(screen.getByLabelText<HTMLInputElement>('Password'));
  });

  it('is keyboard reachable and toggles the platform login password without changing it', () => {
    render(<PlatformLoginForm />);

    expectAccessiblePasswordToggle(screen.getByLabelText<HTMLInputElement>('Password'));
  });
});
