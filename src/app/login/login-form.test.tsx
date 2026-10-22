import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { LoginForm } from './login-form';

describe('LoginForm contrast', () => {
  it('uses the AA-safe muted text token for placeholders and the password divider', () => {
    render(
      <LoginForm
        callbackUrl="/dashboard"
        connections={[{ id: 'sso-1', name: 'Example SSO', protocol: 'OIDC' }]}
        ssoEnforced={false}
      />
    );

    for (const field of [
      screen.getByPlaceholderText('you@company.com'),
      screen.getByPlaceholderText('Enter your password'),
    ]) {
      expect(field).toHaveClass('placeholder:text-text-muted');
      expect(field).not.toHaveClass('placeholder:text-text-faint');
    }

    expect(screen.getByText('or password')).toHaveClass('text-text-muted');
    expect(screen.getByText('or password')).not.toHaveClass('text-text-faint');
  });
});
