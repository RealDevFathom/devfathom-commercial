import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    passwordReset: {
      validate: { useQuery: () => ({ data: { valid: true }, isLoading: false }) },
      reset: { useMutation: () => ({ mutateAsync: mocks.mutate, isPending: false }) },
    },
  },
}));
import { ResetPasswordForm } from './reset-password-form';
afterEach(cleanup);
it('keeps password mismatch and server errors associated and announced', async () => {
  mocks.mutate.mockRejectedValue(new Error('Reset link expired'));
  render(<ResetPasswordForm token="test-token" />);
  const password = screen.getByLabelText('New Password');
  const confirm = screen.getByLabelText('Confirm Password');
  fireEvent.change(password, { target: { value: 'Strong-Password92!' } });
  fireEvent.change(confirm, { target: { value: 'mismatch' } });
  expect(confirm).toHaveAttribute('aria-invalid', 'true');
  expect(confirm).toHaveAccessibleDescription('Passwords do not match.');
  fireEvent.change(confirm, { target: { value: 'Strong-Password92!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
  await screen.findByRole('alert');
  expect(confirm).toHaveAccessibleDescription('Reset link expired');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveValue('Strong-Password92!');
});
