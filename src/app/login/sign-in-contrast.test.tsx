/**
 * DEV-325 — tenant sign-in text must meet WCAG 1.4.3 AA (4.5:1).
 *
 * `--text-faint` (#a3a39e on white, 2.53:1) is for decorative metadata only; it
 * failed AA for the email/password placeholders, the "or password" divider and
 * the workspace picker labels. Those now use `--text-muted`, whose contrast on
 * every Studio surface is asserted in `src/components/theme-provider.test.tsx`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));

import { LoginForm } from './login-form';
import { SharedLoginForm } from './shared-login-form';

afterEach(() => vi.unstubAllGlobals());

/** Every text-bearing element (not decorative icons) styled with the faint ink. */
function faintText(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('*')].filter(
    (element) =>
      !(element instanceof SVGElement) &&
      [...element.classList].some((name) => /(^|:)text-text-faint$/.test(name))
  );
}

it('renders tenant login placeholders and the SSO divider at AA contrast', () => {
  const { container } = render(
    <LoginForm
      callbackUrl="/dashboard"
      ssoEnforced={false}
      connections={[{ id: 'saml', name: 'Corporate SAML', protocol: 'SAML' }]}
    />
  );

  for (const field of [screen.getByLabelText('Email'), screen.getByLabelText('Password')]) {
    expect(field).toHaveAttribute('placeholder');
    expect(field).toHaveClass('placeholder:text-text-muted');
  }
  expect(screen.getByText('or password')).toHaveClass('text-text-muted');
  expect(faintText(container)).toEqual([]);
});

it('renders shared-host sign-in placeholders at AA contrast', () => {
  const { container } = render(<SharedLoginForm callbackUrl="/dashboard" />);

  for (const field of [screen.getByLabelText('Email'), screen.getByLabelText('Password')]) {
    expect(field).toHaveAttribute('placeholder');
    expect(field).toHaveClass('placeholder:text-text-muted');
  }
  expect(faintText(container)).toEqual([]);
});

it('renders workspace picker metadata at AA contrast', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'multiple',
          organizations: [
            {
              id: 'org-a',
              slug: 'alpha',
              displayName: 'Alpha',
              ssoEnforced: false,
              ssoUrl: null,
            },
            {
              id: 'org-b',
              slug: 'beta',
              displayName: 'Beta',
              ssoEnforced: true,
              ssoUrl: null,
            },
          ],
        }),
        { status: 200 }
      )
    )
  );
  const { container } = render(<SharedLoginForm callbackUrl="/dashboard" />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('alpha')).toHaveClass('text-text-muted');
  expect(screen.getByText('Contact your administrator')).toHaveClass('text-text-muted');
  expect(faintText(container)).toEqual([]);
});
