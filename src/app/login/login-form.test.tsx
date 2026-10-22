import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('./use-hydrated', () => ({ useHydrated: () => true }));

import { LoginForm } from './login-form';

describe('LoginForm password visibility', () => {
  it('keeps the show-password button in the keyboard tab order', () => {
    render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

    expect(screen.getByRole('button', { name: 'Show password' })).not.toHaveAttribute(
      'tabindex',
      '-1'
    );
  });
});
