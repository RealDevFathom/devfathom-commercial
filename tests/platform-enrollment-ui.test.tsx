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
  fireEvent.submit(container.querySelector('form')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
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
