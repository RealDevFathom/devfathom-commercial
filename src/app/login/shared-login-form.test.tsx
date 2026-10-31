/**
 * WHA-1208 — the shared-host sign-in must not report a tripped rate limiter as a
 * wrong password.
 *
 * `/api/login` answers 401 and 429 with a byte-identical body on purpose, so
 * nothing about the address is observable. The form therefore has to read the
 * STATUS, not the message, to tell the operator which of the two happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));

import { SharedLoginForm } from './shared-login-form';

/** Exactly what the route emits: identical body, distinguished only by status. */
const UNIFORM_FAILURE_BODY = JSON.stringify({
  outcome: 'failed',
  message: 'Invalid email or password. Please try again.',
});

function answerWith(status: number, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(UNIFORM_FAILURE_BODY, { status, headers }))
  );
}

async function submitCredentials() {
  render(<SharedLoginForm callbackUrl="/dashboard" />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alex@company.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  return await screen.findByRole('alert');
}

describe('SharedLoginForm rate-limit reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('says the limit was reached, not that the password was wrong', async () => {
    answerWith(429, { 'retry-after': '240' });

    const alert = await submitCredentials();

    // What happened...
    expect(alert).toHaveTextContent(/too many sign-in attempts/i);
    // ...and what to do about it, with the real wait.
    expect(alert).toHaveTextContent(/wait in 4 minutes and try again/i);
    // Crucially NOT the credential message — retyping the password is not the fix.
    expect(alert).not.toHaveTextContent(/invalid email or password/i);
  });

  it('still reports a genuine credential failure as one', async () => {
    answerWith(401);

    const alert = await submitCredentials();

    expect(alert).toHaveTextContent('Invalid email or password. Please try again.');
    expect(alert).not.toHaveTextContent(/too many/i);
  });

  it('falls back to a vague wait when the server sends no Retry-After', async () => {
    answerWith(429);

    const alert = await submitCredentials();

    expect(alert).toHaveTextContent(/too many sign-in attempts/i);
    expect(alert).toHaveTextContent(/wait in a few minutes and try again/i);
    expect(alert).not.toHaveTextContent(/NaN|undefined|in 0 seconds/);
  });

  it('renders seconds for a short window', async () => {
    answerWith(429, { 'retry-after': '45' });

    expect(await submitCredentials()).toHaveTextContent(/wait in 45 seconds/i);
  });

  it('re-enables the submit button so the operator can retry after the wait', async () => {
    answerWith(429, { 'retry-after': '30' });

    await submitCredentials();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled();
    });
    // A limiter answer must never be mistaken for a successful sign-in.
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('refreshes the authenticated router state before entering a selected workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          outcome: 'select',
          organizations: [
            {
              id: 'org_agency',
              slug: 'northstar-agency',
              displayName: 'Northstar Agency E2E',
              ssoEnforced: false,
              ssoUrl: null,
            },
            {
              id: 'org_other',
              slug: 'alternate-agency',
              displayName: 'Alternate Agency E2E',
              ssoEnforced: false,
              ssoUrl: null,
            },
          ],
        })
      )
    );
    mocks.signIn.mockResolvedValue({ ok: true, error: null });

    render(<SharedLoginForm callbackUrl="/dashboard" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alex@company.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('button', { name: /Northstar Agency E2E/i }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/dashboard'));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replace.mock.invocationCallOrder[0]!
    );
  });
});

it('continues a solo owner straight into the sole workspace, preserving the callback', async () => {
  mocks.signIn.mockResolvedValue({ ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'single',
          organizations: [
            {
              id: 'solo-owner-workspace',
              slug: 'studio',
              displayName: 'Solo studio',
              ssoEnforced: false,
              ssoUrl: null,
            },
          ],
        }),
        { status: 200 }
      )
    )
  );
  render(<SharedLoginForm vertical="agency" callbackUrl="/projects" />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects'));
  expect(mocks.signIn).toHaveBeenCalledWith('login-intent', {
    organizationId: 'solo-owner-workspace',
    totp: '',
    redirect: false,
  });
  expect(screen.queryByText('Where to?')).not.toBeInTheDocument();
});
