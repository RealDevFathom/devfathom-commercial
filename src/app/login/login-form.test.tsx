import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
const m = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: m.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: m.replace }) }));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));
import { LoginForm } from './login-form';
beforeEach(() => vi.resetAllMocks());
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
  expect(reveal.tabIndex).toBe(0);
  fireEvent.click(reveal);
  expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
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

it.each([
  ['credentials', 'Invalid email or password. Please try again.'],
  ['sso_required', 'Password sign-in is disabled. Use your organization identity provider.'],
  ['suspended', 'Your account has been suspended. Please contact your workspace administrator.'],
  [
    'rate_limited',
    'Too many sign-in attempts. Your password was not checked — wait a few minutes and try again.',
  ],
])('associates a %s error with both credentials until either is edited', async (code, message) => {
  m.signIn.mockResolvedValue({ error: 'CredentialsSignin', code });
  render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />);
  const email = screen.getByLabelText('Email');
  const password = screen.getByLabelText('Password');

  fireEvent.change(email, { target: { value: 'missing@example.test' } });
  fireEvent.change(password, { target: { value: 'wrong password' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(email).toHaveValue('missing@example.test');
  expect(password).toHaveValue('wrong password');
  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(email).toHaveAttribute('aria-describedby', alert.id);
  expect(password).toHaveAttribute('aria-describedby', alert.id);
  expect(email).toHaveFocus();

  fireEvent.change(password, { target: { value: 'another password' } });
  expect(email).not.toHaveAttribute('aria-invalid');
  expect(password).not.toHaveAttribute('aria-invalid');
  expect(email).not.toHaveAttribute('aria-describedby');
  expect(password).not.toHaveAttribute('aria-describedby');
});

it('focuses and clears only the authentication-code error through MFA retries', async () => {
  m.signIn
    .mockResolvedValueOnce({ error: 'CredentialsSignin', code: '2fa_required' })
    .mockResolvedValueOnce({ error: 'CredentialsSignin', code: '2fa_invalid' })
    .mockResolvedValueOnce({ ok: true });
  render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />);
  const email = screen.getByLabelText('Email');
  const password = screen.getByLabelText('Password');
  const submit = screen.getByRole('button', { name: 'Sign in' });
  fireEvent.change(email, { target: { value: 'owner@example.test' } });
  fireEvent.change(password, { target: { value: 'correct password' } });
  fireEvent.submit(submit);

  const code = await screen.findByLabelText('Authentication code');
  expect(code).toHaveFocus();
  expect(code).toHaveAttribute('aria-invalid', 'true');
  expect(code).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
  expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code');
  for (const field of [email, password]) {
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).not.toHaveAttribute('aria-describedby');
  }

  // Editing credentials cannot dismiss an error owned by the second factor.
  fireEvent.change(email, { target: { value: 'owner+edited@example.test' } });
  fireEvent.change(password, { target: { value: 'edited password' } });
  expect(screen.getByRole('alert')).toBeVisible();
  fireEvent.change(code, { target: { value: '000000' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(code).not.toHaveAttribute('aria-invalid');
  expect(code).not.toHaveAttribute('aria-describedby');

  // The input is already mounted: autoFocus cannot handle this retry.
  submit.focus();
  await act(async () => {
    fireEvent.submit(submit);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('That code is incorrect or expired');
  expect(code).toHaveFocus();
  expect(code).toHaveValue('000000');
  expect(code).toHaveAttribute('aria-invalid', 'true');
  expect(code).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
  expect(email).toHaveValue('owner+edited@example.test');
  expect(password).toHaveValue('edited password');
  expect(email).not.toHaveAttribute('aria-invalid');
  expect(password).not.toHaveAttribute('aria-invalid');

  fireEvent.change(code, { target: { value: 'recovery-code' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(code).not.toHaveAttribute('aria-invalid');
  expect(code).not.toHaveAttribute('aria-describedby');
  fireEvent.submit(submit);
  await waitFor(() => expect(m.replace).toHaveBeenCalledWith('/dashboard'));
});

it.each(['2fa-required', '2fa-invalid'] as const)(
  'associates a native %s error only with the authentication code',
  (initialError) => {
    render(
      <LoginForm
        callbackUrl="/dashboard"
        ssoEnforced={false}
        connections={[]}
        initialError={initialError}
      />
    );
    const code = screen.getByLabelText('Authentication code');
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
    fireEvent.change(code, { target: { value: '123456' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(code).not.toHaveAttribute('aria-invalid');
    expect(code).not.toHaveAttribute('aria-describedby');
  }
);

it('preserves credentials and describes a network failure until edited', async () => {
  m.signIn.mockRejectedValueOnce(new Error('offline'));
  render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />);
  const email = screen.getByLabelText('Email');
  const password = screen.getByLabelText('Password');
  fireEvent.change(email, { target: { value: 'owner@example.test' } });
  fireEvent.change(password, { target: { value: 'correct password' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(
    'Unable to sign in right now. Please check your connection and try again.'
  );
  expect(email).toHaveFocus();
  expect(email).toHaveValue('owner@example.test');
  expect(password).toHaveValue('correct password');
  for (const field of [email, password]) {
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);
  }
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  fireEvent.change(email, { target: { value: 'another@example.test' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  for (const field of [email, password]) {
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).not.toHaveAttribute('aria-describedby');
  }
});
