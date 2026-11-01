import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const m = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), fetch: vi.fn() }));
vi.mock('next-auth/react', () => ({ signIn: m.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: m.replace }) }));
vi.mock('@/components/app-providers', () => ({ AppProviders: () => null }));

import { LoginForm } from './login-form';
import { SharedLoginForm } from './shared-login-form';
import { describedBy, requiredFieldErrors } from './required-fields';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', m.fetch);
});

const forms = [
  [
    'tenant sign-in',
    () => render(<LoginForm callbackUrl="/dashboard" ssoEnforced={false} connections={[]} />),
  ],
  ['shared sign-in', () => render(<SharedLoginForm callbackUrl="/dashboard" />)],
] as const;

describe.each(forms)('%s with empty fields', (_name, show) => {
  it('names each empty field inline, accessibly, and sends nothing', () => {
    show();
    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    expect(form).toHaveAttribute('novalidate');

    fireEvent.submit(form);

    const emailMessage = screen.getByText('Email is required');
    const passwordMessage = screen.getByText('Password is required');
    expect(emailMessage).toHaveAttribute('role', 'alert');
    expect(passwordMessage).toHaveAttribute('role', 'alert');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')?.split(' ')).toContain(emailMessage.id);
    expect(password.getAttribute('aria-describedby')?.split(' ')).toContain(passwordMessage.id);
    expect(email).toHaveFocus();
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('names only the password when the email is filled, and clears it on typing', () => {
    show();
    const password = screen.getByLabelText('Password');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'qa@example.test' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);

    expect(screen.queryByText('Email is required')).not.toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(password).toHaveFocus();

    fireEvent.change(password, { target: { value: 'secret' } });
    expect(screen.queryByText('Password is required')).not.toBeInTheDocument();
    expect(password).not.toHaveAttribute('aria-describedby');
  });

  it('reserves the error banner space before any error, so a failure cannot shift the form', () => {
    show();
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    const slot = form.previousElementSibling as HTMLElement;
    expect(slot).toHaveClass('min-h-[2.875rem]');
    expect(within(slot).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('required field helpers', () => {
  it('treats a whitespace email as empty but keeps any password', () => {
    expect(requiredFieldErrors('  ', '')).toEqual({
      email: 'Email is required',
      password: 'Password is required',
    });
    expect(requiredFieldErrors('a@b.c', ' ')).toEqual({});
  });

  it('joins only the ids that apply', () => {
    expect(describedBy('a', false, undefined, 'b')).toBe('a b');
    expect(describedBy(false, '')).toBeUndefined();
  });
});
