import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const m = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: m.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: m.replace }) }));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));
import { LoginForm } from './login-form';
beforeEach(() => vi.clearAllMocks());
it('preserves SAML and OIDC entry points and enforced SSO hides credentials', () => {
  render(
    <LoginForm
      callbackUrl="/dashboard"
      ssoEnforced
      connections={[
        { id: 'saml', name: 'Corporate SAML', protocol: 'SAML' },
        { id: 'oidc', name: 'Corporate OIDC', protocol: 'OIDC' },
      ]}
    />
  );
  expect(screen.getByRole('link', { name: 'Continue with Corporate SAML' })).toHaveAttribute(
    'href',
    '/api/sso/saml/saml/start'
  );
  expect(screen.getByRole('link', { name: 'Continue with Corporate OIDC' })).toHaveAttribute(
    'href',
    '/api/sso/oidc/oidc/start'
  );
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
});
it('preserves native credential submit, forgot-password route, and keyboard reachable reveal', () => {
  render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />);
  expect(screen.getByRole('button', { name: 'Sign in' }).closest('form')).toHaveAttribute(
    'action',
    '/login/submit'
  );
  expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
    'href',
    '/forgot-password'
  );
  const reveal = screen.getByRole('button', { name: 'Show password' });
  const password = screen.getByLabelText('Password');
  expect(reveal.tabIndex).toBe(0);
  expect(reveal).toHaveClass('h-11', 'w-11', 'focus-visible:ring-2');
  fireEvent.change(password, { target: { value: 'kept secret' } });
  fireEvent.click(reveal);
  expect(password).toHaveAttribute('type', 'text');
  expect(password).toHaveValue('kept secret');
  fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
  expect(password).toHaveAttribute('type', 'password');
  expect(password).toHaveValue('kept secret');
});
it('retains entered credentials and submits MFA/recovery codes through the existing provider', async () => {
  m.signIn
    .mockResolvedValueOnce({ error: 'CredentialsSignin', code: '2fa_required' })
    .mockResolvedValueOnce({ ok: true });
  render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct password' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  const code = await screen.findByLabelText('Authentication code');
  expect(screen.getByLabelText('Email')).toHaveValue('owner@example.test');
  fireEvent.change(code, { target: { value: 'recovery-code' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(m.replace).toHaveBeenCalledWith('/dashboard'));
  expect(m.signIn).toHaveBeenLastCalledWith('credentials', {
    email: 'owner@example.test',
    password: 'correct password',
    totp: 'recovery-code',
    redirect: false,
  });
});
