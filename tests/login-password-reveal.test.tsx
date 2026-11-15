import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));

import { LoginForm } from '@/app/login/login-form';
import { PlatformLoginForm } from '@/app/platform/(auth)/login/platform-login-form';

describe('login password reveal control', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['tenant', 'platform'] as const)(
    'is keyboard reachable, sized, and toggles visibility without altering the %s value',
    (flow) => {
      render(
        flow === 'tenant' ? (
          <LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />
        ) : (
          <PlatformLoginForm />
        )
      );

      const password = screen.getByLabelText('Password');
      fireEvent.change(password, { target: { value: 'typed secret value' } });

      const reveal = screen.getByRole('button', { name: 'Show password' });
      expect(reveal).not.toHaveAttribute('tabindex');
      expect(reveal.tabIndex).toBe(0);
      expect(reveal).toHaveAttribute('type', 'button');
      expect(reveal).toHaveClass('h-11', 'w-11', 'focus-visible:ring-2');

      reveal.focus();
      expect(reveal).toHaveFocus();
      expect(password).toHaveAttribute('type', 'password');

      fireEvent.click(reveal);
      expect(password).toHaveAttribute('type', 'text');
      expect(password).toHaveValue('typed secret value');
      expect(screen.getByRole('button', { name: 'Hide password' })).toBe(reveal);

      fireEvent.click(reveal);
      expect(password).toHaveAttribute('type', 'password');
      expect(password).toHaveValue('typed secret value');
      expect(screen.getByRole('button', { name: 'Show password' })).toBe(reveal);
    }
  );
});
