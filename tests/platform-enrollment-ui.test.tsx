import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlatformLoginForm } from '@/app/platform/(auth)/login/platform-login-form';
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('keeps enrollment on the login screen, preserves errors, and shows recovery codes before continuing', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ enrollmentRequired: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ secret: 'SYNTHETICKEY' }) })
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'The authentication code is invalid.' }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ recoveryCodes: ['recovery-one'] }) });
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<PlatformLoginForm />);
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'operator@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct password' } });
  fireEvent.submit(container.querySelector('form')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/platform/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'correct password',
      authenticationCode: '',
    }),
  });
  expect(screen.queryByLabelText('Work email')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(router.replace).not.toHaveBeenCalled();
  expect(await screen.findByText('SYNTHETICKEY')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid');
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText('recovery-one')).toBeVisible();
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /I saved my codes/ }));
  expect(router.replace).toHaveBeenCalledWith('/platform');
});
it('resumes an enrollment cookie after refresh and permits logout', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  render(<PlatformLoginForm initialEnrollment />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.getByLabelText('Work email')).toBeVisible());
  expect(fetchMock).toHaveBeenLastCalledWith('/api/platform/session', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
});

it('associates a failed sign-in error with both credentials until either is edited', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Email or password is incorrect.' }),
    })
  );
  const { container } = render(<PlatformLoginForm />);
  const email = screen.getByLabelText('Work email');
  const password = screen.getByLabelText('Password');

  fireEvent.change(email, { target: { value: 'operator@example.test' } });
  fireEvent.change(password, { target: { value: 'wrong password' } });
  fireEvent.submit(container.querySelector('form')!);

  const alert = await screen.findByRole('alert');
  expect(email).toHaveValue('operator@example.test');
  expect(password).toHaveValue('wrong password');
  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(email).toHaveAttribute('aria-describedby', alert.id);
  expect(password).toHaveAttribute('aria-describedby', alert.id);
  expect(email).toHaveFocus();

  fireEvent.change(email, { target: { value: 'another@example.test' } });
  expect(email).toHaveAttribute('aria-invalid', 'false');
  expect(password).toHaveAttribute('aria-invalid', 'false');
  expect(email).not.toHaveAttribute('aria-describedby');
  expect(password).not.toHaveAttribute('aria-describedby');
});

it('preserves submitted values and associates a network failure with the credentials until edited', async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<PlatformLoginForm />);
  const email = screen.getByLabelText('Work email');
  const password = screen.getByLabelText('Password');
  const code = screen.getByLabelText('Authentication code');
  fireEvent.change(email, { target: { value: 'operator@example.test' } });
  fireEvent.change(password, { target: { value: 'correct password' } });
  fireEvent.change(code, { target: { value: 'recovery-code' } });
  fireEvent.submit(container.querySelector('form')!);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(
    'The control desk could not be reached. Check the connection and try again.'
  );
  expect(email).toHaveFocus();
  expect(email).toHaveValue('operator@example.test');
  expect(password).toHaveValue('correct password');
  expect(code).toHaveValue('recovery-code');
  expect(fetchMock).toHaveBeenCalledWith('/api/platform/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'correct password',
      authenticationCode: 'recovery-code',
    }),
  });
  for (const field of [email, password]) {
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);
  }
  expect(screen.getByRole('button', { name: 'Continue to control desk' })).toBeEnabled();
  fireEvent.change(password, { target: { value: 'another password' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  for (const field of [email, password]) {
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(field).not.toHaveAttribute('aria-describedby');
  }
});
