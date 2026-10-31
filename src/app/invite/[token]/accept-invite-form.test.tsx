import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  accept: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    invitations: {
      get: {
        useQuery: () => ({
          data: {
            name: 'Alex Member',
            email: 'alex@example.test',
            title: 'Staff',
            department: 'OPERATIONS',
            role: 'EMPLOYEE',
          },
        }),
      },
      accept: { useMutation: () => ({ mutateAsync: mocks.accept, isPending: false }) },
    },
  },
}));
import { AcceptInviteForm } from './accept-invite-form';

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.accept.mockResolvedValue({});
  mocks.signIn.mockResolvedValue({ error: null });
});
function submit() {
  render(<AcceptInviteForm token="invitation" />);
  fireEvent.change(screen.getByLabelText(/New Password/), {
    target: { value: 'Strong-Password92!' },
  });
  fireEvent.change(screen.getByLabelText(/Confirm Password/), {
    target: { value: 'Strong-Password92!' },
  });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+15551234567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}
it('activates the account and signs in before entering role-based landing', async () => {
  submit();
  await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/dashboard?landing=1'));
  expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ token: 'invitation' }));
  expect(mocks.signIn).toHaveBeenCalledWith(
    'credentials',
    expect.objectContaining({ email: 'alex@example.test', redirect: false })
  );
  expect(mocks.router.refresh).toHaveBeenCalledOnce();
});
it.each([{ error: 'invalid' }, undefined])(
  'returns to login when auto sign-in fails: %s',
  async (result) => {
    mocks.signIn.mockResolvedValue(result);
    submit();
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/login'));
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  }
);
it.each(['accept', 'signIn'] as const)(
  'keeps the form recoverable when %s rejects',
  async (stage) => {
    mocks[stage].mockRejectedValue(new Error('Please try again.'));
    submit();
    expect(await screen.findByText('Please try again.')).toBeVisible();
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    if (stage === 'accept') expect(mocks.signIn).not.toHaveBeenCalled();
  }
);

it('associates a confirmation mismatch and submission error with the fields', async () => {
  render(<AcceptInviteForm token="invitation" />);
  const password = screen.getByLabelText(/New Password/);
  const confirm = screen.getByLabelText(/Confirm Password/);
  fireEvent.change(password, { target: { value: 'Strong-Password92!' } });
  fireEvent.change(confirm, { target: { value: 'different' } });
  expect(confirm).toHaveAttribute('aria-invalid', 'true');
  expect(confirm).toHaveAccessibleDescription('Passwords do not match.');
  fireEvent.change(confirm, { target: { value: 'Strong-Password92!' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+17865550100' } });
  mocks.accept.mockRejectedValueOnce(new Error('Invitation expired'));
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByRole('alert');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(password.getAttribute('aria-describedby')).toContain('account-error');
  expect(confirm).toHaveAccessibleDescription('Invitation expired');
});
