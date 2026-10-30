import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ForgotPasswordForm } from './forgot-password-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('associates validation errors with the labelled email field and preserves its value', async () => {
  render(<ForgotPasswordForm />);
  const input = screen.getByLabelText('Email');
  fireEvent.change(input, { target: { value: 'invalid' } });
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('alert');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription('Please enter a valid email address');
  expect(input).toHaveValue('invalid');
});
it('announces the same confirmation after a failed request without revealing accounts', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
  render(<ForgotPasswordForm />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('If an account exists for that email')
  );
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
});
