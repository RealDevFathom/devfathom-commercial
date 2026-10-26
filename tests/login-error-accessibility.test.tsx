import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));

import { LoginForm } from '@/app/login/login-form';
import { PlatformLoginForm } from '@/app/platform/(auth)/login/platform-login-form';

function expectCredentialError(
  email: HTMLElement,
  password: HTMLElement,
  alert: HTMLElement,
  errorId: string
) {
  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(alert).toHaveAttribute('id', errorId);
  expect(email).toHaveAttribute('aria-describedby', errorId);
  expect(password).toHaveAttribute('aria-describedby', errorId);
  expect(email).toHaveFocus();
}

describe('login credential error accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('associates a tenant sign-in failure with both fields until either field is edited', async () => {
    mocks.signIn.mockResolvedValue({ error: 'CredentialsSignin', code: 'credentials' });
    render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    fireEvent.change(email, { target: { value: 'nobody@example.invalid' } });
    fireEvent.change(password, { target: { value: 'incorrect-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expectCredentialError(email, password, alert, 'login-sign-in-error');

    fireEvent.change(password, { target: { value: 'another-password' } });
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(password).not.toHaveAttribute('aria-invalid');
    expect(email).not.toHaveAttribute('aria-describedby');
    expect(password).not.toHaveAttribute('aria-describedby');
  });

  it('associates a platform sign-in failure with both fields until either field is edited', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Email or password is incorrect.' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformLoginForm />);

    const email = screen.getByLabelText('Work email');
    const password = screen.getByLabelText('Password');
    fireEvent.change(email, { target: { value: 'operator@example.invalid' } });
    fireEvent.change(password, { target: { value: 'incorrect-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continue to control desk' }));

    const alert = await screen.findByRole('alert');
    expectCredentialError(email, password, alert, 'platform-sign-in-error');

    fireEvent.change(email, { target: { value: 'another@example.invalid' } });
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(password).not.toHaveAttribute('aria-invalid');
    expect(email).not.toHaveAttribute('aria-describedby');
    expect(password).not.toHaveAttribute('aria-describedby');
  });

  it('associates a tenant network failure with both credential fields', async () => {
    mocks.signIn.mockRejectedValue(new Error('network unavailable'));
    render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    fireEvent.change(email, { target: { value: 'nobody@example.invalid' } });
    fireEvent.change(password, { target: { value: 'incorrect-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expectCredentialError(email, password, alert, 'login-sign-in-error');
  });

  it.each(['2fa_required', '2fa_invalid'])(
    'associates a tenant %s failure only with the authentication code',
    async (code) => {
      mocks.signIn.mockResolvedValue({ error: 'CredentialsSignin', code });
      render(<LoginForm connections={[]} ssoEnforced={false} callbackUrl="/dashboard" />);

      fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

      const alert = await screen.findByRole('alert');
      const email = screen.getByLabelText('Email');
      const password = screen.getByLabelText('Password');
      const authenticationCode = screen.getByLabelText('Authentication code');
      expect(alert).toHaveAttribute('id', 'login-sign-in-error');
      expect(authenticationCode).toHaveAttribute('aria-invalid', 'true');
      expect(authenticationCode).toHaveAttribute('aria-describedby', 'login-sign-in-error');
      expect(authenticationCode).toHaveFocus();
      expect(email).not.toHaveAttribute('aria-invalid');
      expect(password).not.toHaveAttribute('aria-invalid');

      fireEvent.change(authenticationCode, { target: { value: '123456' } });
      expect(authenticationCode).not.toHaveAttribute('aria-invalid');
      expect(authenticationCode).not.toHaveAttribute('aria-describedby');
    }
  );

  it('associates a platform network failure with both credential fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockRejectedValueOnce(new Error('network unavailable'))
    );
    render(<PlatformLoginForm />);

    const email = screen.getByLabelText('Work email');
    const password = screen.getByLabelText('Password');
    fireEvent.change(email, { target: { value: 'operator@example.invalid' } });
    fireEvent.change(password, { target: { value: 'incorrect-password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continue to control desk' }));

    const alert = await screen.findByRole('alert');
    expectCredentialError(email, password, alert, 'platform-sign-in-error');
  });

  it('associates a platform MFA failure with every implicated field', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({
            error: 'Email, password, or authentication code is incorrect.',
          }),
        })
    );
    render(<PlatformLoginForm />);

    fireEvent.submit(screen.getByRole('button', { name: 'Continue to control desk' }));

    const alert = await screen.findByRole('alert');
    const email = screen.getByLabelText('Work email');
    const password = screen.getByLabelText('Password');
    const authenticationCode = screen.getByLabelText('Authentication code');
    expect(alert).toHaveAttribute('id', 'platform-sign-in-error');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', 'platform-sign-in-error');
    expect(password).toHaveAttribute('aria-describedby', 'platform-sign-in-error');
    expect(authenticationCode).toHaveAttribute('aria-invalid', 'true');
    expect(authenticationCode).toHaveAttribute('aria-describedby', 'platform-sign-in-error');
    expect(authenticationCode).toHaveFocus();

    fireEvent.change(authenticationCode, { target: { value: '123456' } });
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(password).not.toHaveAttribute('aria-invalid');
    expect(authenticationCode).not.toHaveAttribute('aria-invalid');
  });
});
